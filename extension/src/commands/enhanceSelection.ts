import * as vscode from 'vscode';
import {
  DEFAULT_MODE,
  MAX_ROUGH_TEXT_CHARS,
  PromptInputError,
  renderEnhancePrompt,
  TEMPLATE_VERSION,
} from '@prompt-enhancer/prompts';

import { log } from '../log.js';

/**
 * Phase 1 implementation of Flow A (TDD §8).
 *
 * Everything up to the model call is real: selection capture, the §6 input
 * caps, prompt rendering from the shared template, and the §9.1 guarantee that
 * a failure never touches the document. Instead of calling a model it opens the
 * rendered prompt in a preview document — which verifies that the workspace
 * package resolves inside the extension host, the integration risk this phase
 * exists to retire.
 *
 * Phase 2 replaces the preview with the Gemini call and the in-place
 * `editBuilder.replace()`.
 */
export async function enhanceSelection(): Promise<void> {
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

  const roughText = editor.document.getText(selection);
  if (roughText.trim().length === 0) {
    void vscode.window.showInformationMessage('Prompt Enhancer: the selection is only whitespace.');
    return;
  }

  if (roughText.length > MAX_ROUGH_TEXT_CHARS) {
    void vscode.window.showErrorMessage(
      `Prompt Enhancer: selection is ${roughText.length.toLocaleString()} characters, ` +
        `over the ${MAX_ROUGH_TEXT_CHARS.toLocaleString()} limit. Narrow the selection.`,
    );
    return;
  }

  try {
    const rendered = renderEnhancePrompt({
      roughText,
      context: `language: ${editor.document.languageId}`,
      mode: DEFAULT_MODE,
    });

    log.info(
      `rendered ${TEMPLATE_VERSION} (mode ${DEFAULT_MODE}) for a ${roughText.length}-char selection`,
    );

    const preview = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: [
        `<!-- Phase 1 preview: ${TEMPLATE_VERSION}, mode ${DEFAULT_MODE}. No model call yet. -->`,
        '',
        '# System',
        '',
        rendered.system,
        '',
        '# User',
        '',
        rendered.user,
        '',
      ].join('\n'),
    });
    await vscode.window.showTextDocument(preview, { preview: true, viewColumn: vscode.ViewColumn.Beside });
  } catch (error) {
    // §9.1: the document is never modified on failure — there is nothing to roll back.
    const message =
      error instanceof PromptInputError
        ? `Prompt Enhancer: ${error.message}.`
        : 'Prompt Enhancer: could not build the prompt. See the Prompt Enhancer output for details.';
    log.error('enhanceSelection failed', error);
    const action = await vscode.window.showErrorMessage(message, 'Open Output');
    if (action === 'Open Output') {
      log.show();
    }
  }
}
