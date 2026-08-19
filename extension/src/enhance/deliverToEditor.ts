import * as vscode from 'vscode';

import { log } from '../log.js';

/**
 * §8 Flow A.6- the one place in this extension that writes to a user's
 * document.
 *
 * It lives in its own module because it is the code the §9.1 guarantee is about,
 * and because that guarantee is only worth anything if it is tested against a
 * real editor. `extension/integration/flowA.test.ts` calls `applyEnhancement`
 * directly in a live VS Code instance- asserting the replace is a single undo
 * step, and that a document which moved under us is not written to at all-
 * neither of which can be checked with a stubbed `vscode` module.
 */

export interface DeliveryTarget {
  readonly editor: vscode.TextEditor;
  readonly document: vscode.TextDocument;
  /** The range as it was when the request started. */
  readonly range: vscode.Range;
  readonly versionAtStart: number;
  /** The text that was in `range` at that moment. */
  readonly roughText: string;
}

export type DeliveryOutcome =
  /** Written in place, as one undo step. */
  | 'replaced'
  /** Not written: the document moved, or the editor refused. Shown in a tab. */
  | 'preview-document-changed'
  | 'preview-edit-refused';

/**
 * Whether the document still is what it was when the request started.
 *
 * The version check is the load-bearing half: if the user edited during the
 * request, the captured range no longer means what it meant, and replacing on it
 * would corrupt the buffer. The text comparison is belt and braces- a version
 * bump with identical text (an edit then an undo) is still treated as moved,
 * which is the conservative direction.
 */
export function documentMoved(target: DeliveryTarget): boolean {
  if (target.document.isClosed) {
    return true;
  }
  if (target.document.version !== target.versionAtStart) {
    return true;
  }
  return target.document.getText(target.range) !== target.roughText;
}

/**
 * Applies the enhancement, or declines to and says so. Never partially writes,
 * and never writes empty or whitespace-only text over a selection (§9.1).
 *
 * The caller is responsible for telling the user; this returns what happened.
 */
export async function applyEnhancement(
  target: DeliveryTarget,
  enhanced: string,
): Promise<DeliveryOutcome> {
  if (enhanced.trim().length === 0) {
    // Should be unreachable- both the adapter and `runEnhance` reject empty
    // text- which is exactly why it is worth refusing here too. The cost of
    // being wrong is the user's selection.
    throw new Error('refusing to write an empty enhancement over a selection');
  }

  if (documentMoved(target)) {
    log.warn('document changed during the request- showing a preview instead of replacing');
    await showPreview(enhanced);
    return 'preview-document-changed';
  }

  // One `replace` in one edit, so it is one undo step (§8 A.6). The undo stops
  // are explicit rather than defaulted: this being a single step is a tested
  // guarantee, not an incidental one.
  const applied = await target.editor.edit(
    (builder) => builder.replace(target.range, enhanced),
    { undoStopBefore: true, undoStopAfter: true },
  );

  if (!applied) {
    // VS Code refused the edit- e.g. the editor is no longer visible. The rule
    // holds: the document is not half-written, and the work is not lost.
    log.warn('editor.edit returned false- showing a preview instead of replacing');
    await showPreview(enhanced);
    return 'preview-edit-refused';
  }

  log.info('selection replaced');
  return 'replaced';
}

/** The fallback delivery: an untitled markdown document holding the result. */
export async function showPreview(enhanced: string): Promise<vscode.TextDocument> {
  const preview = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: enhanced.endsWith('\n') ? enhanced : `${enhanced}\n`,
  });
  await vscode.window.showTextDocument(preview, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
  return preview;
}
