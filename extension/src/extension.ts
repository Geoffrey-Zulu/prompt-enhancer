import * as vscode from 'vscode';
import { TEMPLATE_VERSION } from '@prompt-enhancer/prompts';

import { clearApiKey } from './commands/clearApiKey.js';
import { enhanceSelection } from './commands/enhanceSelection.js';
import { selectModel } from './commands/selectModel.js';
import { setApiKey } from './commands/setApiKey.js';
import { initLog, log } from './log.js';
import { createServices } from './services/index.js';

/**
 * Registration only — no logic lives here (TDD §3).
 */
export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log.info(`activated — template ${TEMPLATE_VERSION}`);

  // Built once and passed in. Nothing is held at module scope, so there is no
  // place an API key could be cached by accident (§7).
  const services = createServices(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.enhanceSelection', () =>
      enhanceSelection(services),
    ),
    vscode.commands.registerCommand('promptEnhancer.setApiKey', () => setApiKey(services)),
    vscode.commands.registerCommand('promptEnhancer.clearApiKey', () => clearApiKey(services)),
    vscode.commands.registerCommand('promptEnhancer.selectModel', () => selectModel(services)),
  );
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}
