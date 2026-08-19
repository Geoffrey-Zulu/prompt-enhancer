import * as vscode from 'vscode';
import { DEFAULT_MODE, MAX_ROUGH_TEXT_CHARS } from '@prompt-enhancer/prompts';

import { applyEnhancement, type DeliveryTarget } from '../enhance/deliverToEditor.js';
import { reportFailure } from '../enhance/report.js';
import { runEnhance } from '../enhance/runEnhance.js';
import { resolveSession } from '../enhance/session.js';
import type { Services } from '../services/index.js';

/**
 * Flow A- editor enhancement, in place (TDD §8).
 *
 * The rule this file exists to keep is §9.1: **a failed enhancement never
 * modifies the document.** The only write lives in
 * `enhance/deliverToEditor.ts`, it is reached only after the call has returned a
 * confirmed non-empty result, and every failure path here returns before it.
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

  // §8 A.2- capture the range, the document version and the language up front.
  // Everything after this compares against these, not against whatever the
  // editor happens to look like when the call comes back.
  const document = editor.document;
  const target: DeliveryTarget = {
    editor,
    document,
    range: new vscode.Range(selection.start, selection.end),
    versionAtStart: document.version,
    roughText: document.getText(new vscode.Range(selection.start, selection.end)),
  };

  if (target.roughText.trim().length === 0) {
    void vscode.window.showInformationMessage('Prompt Enhancer: the selection is only whitespace.');
    return;
  }

  // §6 input caps, enforced before any call. `renderEnhancePrompt` enforces them
  // again; this one exists to give a message that says what to do.
  if (target.roughText.length > MAX_ROUGH_TEXT_CHARS) {
    void vscode.window.showErrorMessage(
      `Prompt Enhancer: selection is ${target.roughText.length.toLocaleString()} characters, ` +
        `over the ${MAX_ROUGH_TEXT_CHARS.toLocaleString()} limit. Narrow the selection.`,
    );
    return;
  }

  // §8 A.4- no key at all is reported with a "Set API Key" action and stops
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
              roughText: target.roughText,
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
    // §9.1: nothing has been written, and nothing will be. A cancellation is
    // reported as nothing at all- the document is simply left alone.
    await reportFailure(error, {
      provider: session.provider,
      model: session.model,
      retry: () => enhanceSelection(services),
    });
    return;
  }

  const outcome = await applyEnhancement(target, enhanced);

  if (outcome === 'preview-document-changed') {
    void vscode.window.showInformationMessage(
      'Prompt Enhancer: the document changed while the prompt was being enhanced, so the selection was left alone. The result is in a new tab.',
    );
  } else if (outcome === 'preview-edit-refused') {
    void vscode.window.showInformationMessage(
      'Prompt Enhancer: the selection could not be replaced, so the result is in a new tab.',
    );
  }
}
