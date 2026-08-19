import assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { applyEnhancement, documentMoved } from '../src/enhance/deliverToEditor.js';

/**
 * The §9.1 guarantees, against a real editor (TDD §12).
 *
 * These call `applyEnhancement` directly with a canned result rather than driving
 * a model. That is deliberate: the thing under test is what happens to the user's
 * buffer, and pinning that down should not depend on a network call, an API key,
 * or what a model happened to return today. The model call has its own coverage —
 * `providers/*.request.test.ts` for the wire, `providers/live.test.ts` for real
 * APIs.
 */

const EXTENSION_ID = 'TBD.prompt-enhancer';
const ROUGH = 'fix the null check in findById';
const ENHANCED = '## Role\nYou are a senior engineer.\n\n## Task\nFix the null check.\n';

/**
 * A document owns its end-of-line sequence, and VS Code normalises inserted text
 * to it. A single-line untitled document has no newline to infer one from, so on
 * Windows it gets CRLF and the enhancement comes back with CRLF — correct editor
 * behaviour. Comparing raw text would assert on whichever platform ran the suite
 * rather than on anything the extension does.
 */
function eol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

interface Fixture {
  editor: vscode.TextEditor;
  document: vscode.TextDocument;
  range: vscode.Range;
}

/** A real untitled document with its whole content selected. */
async function openWithSelection(content = ROUGH): Promise<Fixture> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content,
  });
  const editor = await vscode.window.showTextDocument(document);
  const range = new vscode.Range(document.positionAt(0), document.positionAt(content.length));
  editor.selection = new vscode.Selection(range.start, range.end);
  return { editor, document, range };
}

function targetFor(fixture: Fixture): Parameters<typeof applyEnhancement>[0] {
  return {
    editor: fixture.editor,
    document: fixture.document,
    range: fixture.range,
    versionAtStart: fixture.document.version,
    roughText: fixture.document.getText(fixture.range),
  };
}

async function closeEverything(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/**
 * Polls until `predicate` holds, or gives up.
 *
 * `executeCommand('undo')` resolves when the command has been *dispatched*, not
 * when the document model reflects it, so asserting immediately after it is a
 * race — one that passes almost always and fails just often enough to teach
 * people to re-run the suite. The single-undo-step guarantee is the most
 * important thing this file asserts; it does not get to be flaky.
 */
async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite('Flow A — delivery to the editor', () => {
  suiteSetup(async () => {
    // Activated explicitly so the suite does not depend on the order mocha
    // happens to load files in — a test that only passes second is not a test.
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('replaces the selection in place', async () => {
    const fixture = await openWithSelection();

    const outcome = await applyEnhancement(targetFor(fixture), ENHANCED);

    assert.equal(outcome, 'replaced');
    assert.equal(eol(fixture.document.getText()), ENHANCED);
  });

  test('is a single undo step', async () => {
    // §8 A.6, and the reason the whole replace is one `editBuilder.replace` in
    // one `editor.edit`. If it were two edits, one undo would leave the user
    // looking at half an enhancement — the §9.1 failure in slow motion.
    const fixture = await openWithSelection();

    await applyEnhancement(targetFor(fixture), ENHANCED);
    assert.equal(eol(fixture.document.getText()), ENHANCED);

    await vscode.commands.executeCommand('undo');
    await waitFor(
      () => eol(fixture.document.getText()) !== ENHANCED,
      'the undo to reach the document',
    );

    assert.equal(
      eol(fixture.document.getText()),
      ROUGH,
      'one undo should restore the original text exactly',
    );
  });

  test('does not write when the document changed during the request', async () => {
    // §8 A.6. The captured range no longer means what it meant, so replacing on
    // it would corrupt the buffer.
    const fixture = await openWithSelection();
    const target = targetFor(fixture);

    // Simulate the user typing while the request was in flight.
    await fixture.editor.edit((builder) => {
      builder.insert(fixture.document.positionAt(0), 'user typed this\n');
    });
    const textAfterUserEdit = fixture.document.getText();

    const outcome = await applyEnhancement(target, ENHANCED);

    assert.equal(outcome, 'preview-document-changed');
    assert.equal(
      eol(fixture.document.getText()),
      eol(textAfterUserEdit),
      'the buffer must be exactly as the user left it',
    );
    assert.ok(
      !fixture.document.getText().includes('## Role'),
      'the enhancement must not have been written anywhere in the document',
    );
  });

  test('detects a moved document by version, not just by text', async () => {
    const fixture = await openWithSelection();
    const target = targetFor(fixture);

    assert.equal(documentMoved(target), false);

    // An edit followed by an undo leaves the text identical but the version
    // bumped. Treating that as moved is the conservative direction.
    await fixture.editor.edit((builder) => {
      builder.insert(fixture.document.positionAt(0), 'x');
    });
    await vscode.commands.executeCommand('undo');
    await waitFor(
      () => eol(fixture.document.getText()) === ROUGH,
      'the undo to reach the document',
    );

    assert.equal(eol(fixture.document.getText()), ROUGH, 'text is back to the original');
    assert.equal(documentMoved(target), true, 'but the version moved, so it counts as moved');
  });

  test('refuses to write an empty or whitespace-only result', async () => {
    // §9.1 spells this out: no writing an empty result over a selection. It
    // should be unreachable, which is exactly why it is asserted.
    const fixture = await openWithSelection();

    for (const empty of ['', '   \n\t ']) {
      await assert.rejects(() => applyEnhancement(targetFor(fixture), empty));
      assert.equal(eol(fixture.document.getText()), ROUGH, 'the buffer is untouched');
    }
  });

  test('puts the result in a preview document rather than losing it', async () => {
    const fixture = await openWithSelection();
    const target = targetFor(fixture);
    await fixture.editor.edit((builder) => {
      builder.insert(fixture.document.positionAt(0), 'moved\n');
    });

    await applyEnhancement(target, ENHANCED);

    // The work is not thrown away when it cannot be applied.
    const previewIsOpen = vscode.workspace.textDocuments.some((document) =>
      document.getText().includes('## Role'),
    );
    assert.ok(previewIsOpen, 'the enhancement should be readable in some open document');
  });
});

suite('chat delivery commands', () => {
  suiteSetup(async () => {
    // These three commands are registered in code rather than contributed, so
    // package.json declares `onCommand:` activation events for them. Without
    // those, a chat button clicked after a window reload fails with "command not
    // found" — which is how this suite found that gap.
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  teardown(async () => {
    await closeEverything();
  });

  test('Insert into editor puts the text at the cursor', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: 'before\nafter',
    });
    const editor = await vscode.window.showTextDocument(document);
    const cursor = document.positionAt('before\n'.length);
    editor.selection = new vscode.Selection(cursor, cursor);

    await vscode.commands.executeCommand('promptEnhancer.insertResult', 'INSERTED');

    assert.equal(eol(document.getText()), 'before\nINSERTEDafter');
  });

  test('Insert into editor replaces a selection when there is one', async () => {
    const fixture = await openWithSelection('replace me');

    await vscode.commands.executeCommand('promptEnhancer.insertResult', 'INSERTED');

    assert.equal(eol(fixture.document.getText()), 'INSERTED');
  });

  test('Insert into editor does nothing when handed nothing', async () => {
    const fixture = await openWithSelection('untouched');

    await vscode.commands.executeCommand('promptEnhancer.insertResult', '   ');
    await vscode.commands.executeCommand('promptEnhancer.insertResult', undefined);

    assert.equal(eol(fixture.document.getText()), 'untouched');
  });

  test('Copy puts the text on the clipboard', async () => {
    await vscode.commands.executeCommand('promptEnhancer.copyResult', 'COPIED TEXT');

    assert.equal(await vscode.env.clipboard.readText(), 'COPIED TEXT');
  });
});
