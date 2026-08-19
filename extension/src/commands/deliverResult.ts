import * as vscode from 'vscode';

import { log } from '../log.js';

/**
 * The two delivery actions the panel offers.
 *
 * Both are registered in code and deliberately **not** contributed to
 * `package.json`: each takes the text as an argument, so a command-palette entry
 * would be a broken one. The contribution rule is about not shipping dead
 * palette entries, and these would be exactly that.
 */

/**
 * Inserts the enhanced prompt at the cursor, or over the selection if there is
 * one. Unlike the editor rewrite this is not a change the user might not be
 * expecting- they clicked a button- so there is no document-version guard to
 * keep: the target is wherever the cursor is *now*, which is what "insert into
 * editor" means.
 */
export async function insertResult(text?: unknown): Promise<void> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    log.warn('insertResult called with nothing to insert');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage(
      'Prompt Enhancer: open a file to insert the prompt into.',
    );
    return;
  }

  const selection = editor.selection;
  const applied = await editor.edit((builder) => {
    if (selection.isEmpty) {
      builder.insert(selection.active, text);
    } else {
      builder.replace(selection, text);
    }
  });

  if (!applied) {
    log.warn('insertResult: editor.edit returned false');
    void vscode.window.showErrorMessage(
      'Prompt Enhancer: could not insert into that editor. The prompt is still in the chat panel.',
    );
    return;
  }

  log.info(`inserted ${text.length} chars into ${editor.document.languageId}`);
}

export async function copyResult(text?: unknown): Promise<void> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    log.warn('copyResult called with nothing to copy');
    return;
  }

  await vscode.env.clipboard.writeText(text);
  log.info(`copied ${text.length} chars to the clipboard`);
  void vscode.window.setStatusBarMessage('Prompt Enhancer: copied', 3_000);
}
