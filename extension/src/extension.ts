import * as vscode from 'vscode';
import { TEMPLATE_VERSION } from '@prompt-enhancer/prompts';

import { clearApiKey } from './commands/clearApiKey.js';
import { copyResult, insertResult } from './commands/deliverResult.js';
import { enhancePrompt } from './commands/enhancePrompt.js';
import { enhanceSelection } from './commands/enhanceSelection.js';
import { selectModel } from './commands/selectModel.js';
import { setApiKey } from './commands/setApiKey.js';
import { initLog, log } from './log.js';
import { createServices } from './services/index.js';
import { PromptEnhancerViewProvider } from './view/panel.js';

/**
 * Registration only- no logic lives here (TDD §3).
 */
export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log.info(`activated- template ${TEMPLATE_VERSION}`);

  // Built once and passed in. Nothing is held at module scope, so there is no
  // place an API key could be cached by accident (§7).
  const services = createServices(context);
  const panel = new PromptEnhancerViewProvider(context.extensionUri, services);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PromptEnhancerViewProvider.viewId, panel, {
      // The panel keeps a draft and a result; rebuilding it on every tab switch
      // would throw both away.
      webviewOptions: { retainContextWhenHidden: true },
    }),

    // The primary flow: a prompt you are about to send to an AI.
    vscode.commands.registerCommand('promptEnhancer.enhancePrompt', () => enhancePrompt(services)),
    vscode.commands.registerCommand('promptEnhancer.openPanel', async () => {
      await panel.prefill(selectionOrEmpty());
    }),

    // Secondary: rewriting prompt text that lives in a file (CLAUDE.md, an
    // instructions file, a system-prompt string, a scratch note).
    vscode.commands.registerCommand('promptEnhancer.enhanceSelection', () =>
      enhanceSelection(services),
    ),

    vscode.commands.registerCommand('promptEnhancer.setApiKey', () => setApiKey(services)),
    vscode.commands.registerCommand('promptEnhancer.clearApiKey', () => clearApiKey(services)),
    vscode.commands.registerCommand('promptEnhancer.selectModel', () => selectModel(services)),

    // Panel button targets. Registered here but not contributed to package.json:
    // each takes an argument, so a palette entry would be a broken one.
    vscode.commands.registerCommand('promptEnhancer.insertResult', insertResult),
    vscode.commands.registerCommand('promptEnhancer.copyResult', copyResult),
  );
}

function selectionOrEmpty(): string {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty) {
    return '';
  }
  return editor.document.getText(editor.selection).trim();
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}
