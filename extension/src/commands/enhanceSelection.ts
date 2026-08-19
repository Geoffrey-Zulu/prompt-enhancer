import * as vscode from 'vscode';
import { DEFAULT_MODE, MAX_ROUGH_TEXT_CHARS } from '@prompt-enhancer/prompts';

import { reportFailure } from '../enhance/report.js';
import { runEnhance } from '../enhance/runEnhance.js';
import { resolveSession } from '../enhance/session.js';
import { log } from '../log.js';
import type { Services } from '../services/index.js';

/**
 * Flow A — editor enhancement, in place (TDD §8).
 *
 * The rule this file exists to keep is §9.1: **a failed enhancement never
 * modifies the document.** There is exactly one write in here, it happens after
 * the call has returned a confirmed non-empty result, and it is guarded on the
 * document being unchanged. Every failure path returns before reaching it.
 */
export async function enhanceSelection(services: Services): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage('Prompt Enhancer: open a file and select some text.');
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    void vscode.window.showInformationMessage('Prompt Enhancer: select the text to enhance.');
    return;
  }

  // §8 A.2 — capture the range, the document version, and the language up
  // front. Everything after this point compares against these, not against
  // whatever the editor happens to look like when the call comes back.
  const document = editor.document;
  const range = new vscode.Range(selection.start, selection.end);
  const versionAtStart = document.version;
  const roughText = document.getText(range);

  if (roughText.trim().length === 0) {
    void vscode.window.showInformationMessage('Prompt Enhancer: the selection is only whitespace.');
    return;
  }

  // §6 input caps, enforced before any call. `renderEnhancePrompt` enforces
  // them again; this one exists to give a message that says what to do.
  if (roughText.length > MAX_ROUGH_TEXT_CHARS) {
    void vscode.window.showErrorMessage(
      `Prompt Enhancer: selection is ${roughText.length.toLocaleString()} characters, ` +
        `over the ${MAX_ROUGH_TEXT_CHARS.toLocaleString()} limit. Narrow the selection.`,
    );
    return;
  }

  // §8 A.4 — no key at all is reported with a "Set API Key" action and stops
  // here; a key with no model resolved asks, then continues.
  const session = await resolveSession(services);
  if (session === undefined) {
    return;
  }

  let enhanced: string;
  try {
    enhanced = await vscode.window.withProgress(
      {
        // §8 A.5. Naming the model means the user always knows which one answered.
        location: vscode.ProgressLocation.Notification,
        title: `Prompt Enhancer: enhancing with ${session.model}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const cancel = new AbortController();
        const subscription = token.onCancellationRequested(() => cancel.abort());
        try {
          return await runEnhance(
            session,
            {
              roughText,
              context: `language: ${document.languageId}`,
              mode: DEFAULT_MODE,
            },
            cancel.signal,
          );
        } finally {
          subscription.dispose();
        }
      },
    );
  } catch (error) {
    // §9.1: nothing has been written, and nothing will be. Cancellation is
    // reported as nothing at all — the document is simply left alone.
    await reportFailure(error, {
      provider: session.provider,
      model: session.model,
      retry: () => enhanceSelection(services),
    });
    return;
  }

  await applyOrPreview(editor, document, range, versionAtStart, roughText, enhanced);
}

/**
 * §8 A.6 — apply, or preview if the document moved under us.
 *
 * The version check is the important half: if the user edited during the
 * request, the captured range no longer means what it meant, so replacing on it
 * would corrupt the buffer. In that case the result is shown in a preview
 * document and the buffer is left exactly as the user left it.
 */
async function applyOrPreview(
  editor: vscode.TextEditor,
  document: vscode.TextDocument,
  range: vscode.Range,
  versionAtStart: number,
  roughText: string,
  enhanced: string,
): Promise<void> {
  const changed =
    document.isClosed ||
    document.version !== versionAtStart ||
    document.getText(range) !== roughText;

  if (changed) {
    log.warn('document changed during the request — showing a preview instead of replacing');
    await showPreview(enhanced);
    void vscode.window.showInformationMessage(
      'Prompt Enhancer: the document changed while the prompt was being enhanced, so the selection was left alone. The result is in a new tab.',
    );
    return;
  }

  // One `replace` in one edit, so it is one undo step (§8 A.6).
  const applied = await editor.edit(
    (builder) => builder.replace(range, enhanced),
    { undoStopBefore: true, undoStopAfter: true },
  );

  if (!applied) {
    // VS Code refused the edit — e.g. the editor is no longer visible. Same
    // rule applies: the document is not half-written, and the work is not lost.
    log.warn('editor.edit returned false — showing a preview instead of replacing');
    await showPreview(enhanced);
    void vscode.window.showInformationMessage(
      'Prompt Enhancer: the selection could not be replaced, so the result is in a new tab.',
    );
    return;
  }

  log.info('selection replaced');
}

/** The fallback delivery: an untitled markdown document holding the result. */
async function showPreview(enhanced: string): Promise<void> {
  const preview = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: enhanced.endsWith('\n') ? enhanced : `${enhanced}\n`,
  });
  await vscode.window.showTextDocument(preview, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}
