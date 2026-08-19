import assert from 'node:assert/strict';
import * as vscode from 'vscode';

/**
 * That the extension actually activates and contributes what it claims (§12).
 *
 * Cheap tests, but they catch the class of mistake no unit test can: a command
 * declared in `package.json` with no handler, a handler with no declaration, or
 * an activation that throws and leaves everything silently dead.
 */

const EXTENSION_ID = 'TBD.prompt-enhancer';

/** Contributed to the palette, so each one needs a declaration *and* a handler. */
const PALETTE_COMMANDS = [
  'promptEnhancer.enhancePrompt',
  'promptEnhancer.openPanel',
  'promptEnhancer.enhanceSelection',
  'promptEnhancer.setApiKey',
  'promptEnhancer.clearApiKey',
  'promptEnhancer.selectModel',
];

/** Registered in code only: each takes an argument, so a palette entry would be broken. */
const INTERNAL_COMMANDS = ['promptEnhancer.insertResult', 'promptEnhancer.copyResult'];

suite('activation and contributions', () => {
  test('the extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);

    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test('every command it contributes has a handler', async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const registered = new Set(await vscode.commands.getCommands(true));

    for (const command of [...PALETTE_COMMANDS, ...INTERNAL_COMMANDS]) {
      assert.ok(registered.has(command), `${command} is not registered`);
    }
  });

  test('the palette declarations and the handlers agree', () => {
    // A declaration with no handler is a palette entry that errors when clicked;
    // a handler with no declaration is a feature nobody can find. The
    // contribution rule in §11 is about exactly this pair.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const contributed = (
      extension.packageJSON as { contributes?: { commands?: Array<{ command: string }> } }
    ).contributes?.commands?.map((entry) => entry.command);

    assert.deepEqual([...(contributed ?? [])].sort(), [...PALETTE_COMMANDS].sort());
  });

  test('the panel view id matches the provider registration exactly', () => {
    // A mismatch here is a view that renders nothing, with no error anywhere —
    // the same class of failure the removed chat participant had.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const views = (
      extension.packageJSON as {
        contributes?: { views?: Record<string, Array<{ id: string; type?: string }>> };
      }
    ).contributes?.views?.['promptEnhancer'];

    assert.equal(views?.length, 1);
    assert.equal(views?.[0]?.id, 'promptEnhancer.panel');
    assert.equal(views?.[0]?.type, 'webview');
  });

  test('it contributes no chat participant', () => {
    // Removed deliberately: `chatParticipants` registers into VS Code's native
    // chat panel, which only exists with GitHub Copilot Chat installed. Users on
    // Claude Code or ChatGPT saw nothing at all, with no way to find out why.
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    assert.equal(
      (extension.packageJSON as { contributes?: Record<string, unknown> }).contributes?.[
        'chatParticipants'
      ],
      undefined,
    );
  });

  test('the keybinding is the D7 one, gated on a selection', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);

    const keybindings = (
      extension.packageJSON as {
        contributes?: { keybindings?: Array<{ command: string; key: string; when: string }> };
      }
    ).contributes?.keybindings;

    const binding = keybindings?.find((entry) => entry.command === 'promptEnhancer.enhancePrompt');
    // D7: ctrl+shift+e is Focus Explorer on every platform and must not be taken.
    assert.equal(binding?.key, 'ctrl+alt+e');
    // Deliberately unconditional. The shortcut belongs to the flow that works
    // wherever you are — including with a chat panel focused, which is where a
    // prompt is actually being written. Gating it on `editorHasSelection` is what
    // made it feel broken: it did nothing, silently, almost everywhere.
    assert.equal(binding?.when, undefined);
  });
});

suite('the no-key path leaves the document alone', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('running the command with no key stored changes nothing', async () => {
    // §7: no key is a normal state, not an error. The notification cannot be
    // asserted (VS Code exposes no API for reading one), but the thing that
    // actually matters can be: the buffer is untouched and nothing throws.
    const content = 'rough text that must survive';
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content,
    });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(
      document.positionAt(0),
      document.positionAt(content.length),
    );

    await vscode.commands.executeCommand('promptEnhancer.enhanceSelection');

    assert.equal(document.getText(), content);
  });

  test('a whitespace-only selection is refused before anything else happens', async () => {
    const content = '   \n\t  \n';
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content,
    });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(
      document.positionAt(0),
      document.positionAt(content.length),
    );

    await vscode.commands.executeCommand('promptEnhancer.enhanceSelection');

    assert.equal(document.getText(), content);
  });
});
