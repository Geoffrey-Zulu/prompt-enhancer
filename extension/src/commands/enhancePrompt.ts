import * as vscode from 'vscode';
import {
  DEFAULT_MODE,
  isEnhanceMode,
  MAX_ROUGH_TEXT_CHARS,
  type EnhanceMode,
} from '@prompt-enhancer/prompts';

import { reportFailure } from '../enhance/report.js';
import { runEnhance } from '../enhance/runEnhance.js';
import { resolveSession } from '../enhance/session.js';
import { log } from '../log.js';
import type { Services } from '../services/index.js';

/**
 * The primary flow: **enhance a prompt you are about to send to an AI.**
 *
 * The original design put the headline feature on an editor selection, which was
 * the wrong place. A prompt is not something you have lying in a `.tsx` file —
 * it is something you are about to type into a chat box. This command works from
 * anywhere, including with a chat panel focused, and it leaves the result on the
 * clipboard so it can be pasted into whichever chat you actually use.
 *
 * **The clipboard is the bridge, and it has to be.** No extension can read or
 * write another extension's chat input: Claude Code's and ChatGPT's panels are
 * their own webviews with no API surface for this. So "select it in the chat box
 * and press a key" is not buildable by anyone. Handing the text back via the
 * clipboard is the one route that works with every chat, present and future.
 */
export async function enhancePrompt(services: Services): Promise<void> {
  const rough = await askForRoughText();
  if (rough === undefined) {
    return;
  }

  const mode = resolveMode();

  const session = await resolveSession(services);
  if (session === undefined) {
    return;
  }

  let enhanced: string;
  try {
    enhanced = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Prompt Enhancer: enhancing with ${session.model}…`,
        cancellable: true,
      },
      async (_progress, token) => {
        const cancel = new AbortController();
        const subscription = token.onCancellationRequested(() => cancel.abort());
        try {
          return await runEnhance(session, { roughText: rough, mode }, cancel.signal);
        } finally {
          subscription.dispose();
        }
      },
    );
  } catch (error) {
    await reportFailure(error, {
      provider: session.provider,
      model: session.model,
      retry: () => enhancePrompt(services),
    });
    return;
  }

  await deliver(enhanced);
}

/**
 * Asks for the rough prompt, seeded from the editor selection when there is one —
 * so this command subsumes the editor path rather than competing with it.
 */
async function askForRoughText(): Promise<string | undefined> {
  const selection = selectedText();

  const entered = await vscode.window.showInputBox({
    title: 'Prompt Enhancer: enhance a prompt',
    prompt: 'The rough version. The enhanced prompt goes to your clipboard.',
    placeHolder: 'fix the landing page, make it so good',
    value: selection ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (value.trim().length === 0) {
        return null; // Nothing typed yet is not an error, just not ready.
      }
      return value.length > MAX_ROUGH_TEXT_CHARS
        ? `${value.length.toLocaleString()} characters, over the ${MAX_ROUGH_TEXT_CHARS.toLocaleString()} limit.`
        : null;
    },
  });

  if (entered === undefined) {
    return undefined;
  }
  const rough = entered.trim();
  return rough.length === 0 ? undefined : rough;
}

function selectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection).trim();
  // A whole file pasted in as a "prompt" is not what this flow is for, and the
  // input box would be unusable. The editor command handles large selections.
  return text.length === 0 || text.length > 2_000 ? undefined : text;
}

/** The mode setting, validated on read — an unknown value falls back, loudly. */
function resolveMode(): EnhanceMode {
  const configured = vscode.workspace
    .getConfiguration('promptEnhancer')
    .get<string>('defaultMode')
    ?.trim();

  if (configured === undefined || configured.length === 0) {
    return DEFAULT_MODE;
  }
  if (!isEnhanceMode(configured)) {
    log.warn(`ignoring unknown promptEnhancer.defaultMode "${configured}"`);
    return DEFAULT_MODE;
  }
  return configured;
}

/**
 * Clipboard first, then a tab.
 *
 * The clipboard is the point — the next thing the user does is paste this into a
 * chat. The tab exists because a prompt that only lives on the clipboard is one
 * <kbd>Ctrl</kbd>+<kbd>C</kbd> away from being lost, and because it is worth
 * reading before sending.
 */
async function deliver(enhanced: string): Promise<void> {
  await vscode.env.clipboard.writeText(enhanced);
  log.info(`enhanced prompt copied to the clipboard (${enhanced.length} chars)`);

  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: enhanced.endsWith('\n') ? enhanced : `${enhanced}\n`,
  });
  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });

  void vscode.window.setStatusBarMessage(
    '$(clippy) Prompt Enhancer: enhanced prompt copied — paste it into your chat',
    5_000,
  );
}
