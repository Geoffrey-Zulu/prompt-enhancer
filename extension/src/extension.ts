import * as vscode from 'vscode';
import { TEMPLATE_VERSION } from '@prompt-enhancer/prompts';

import { enhanceSelection } from './commands/enhanceSelection.js';
import { initLog, log } from './log.js';

/**
 * Registration only — no logic lives here (TDD §3).
 */
export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  log.info(`activated — template ${TEMPLATE_VERSION}`);

  context.subscriptions.push(
    vscode.commands.registerCommand('promptEnhancer.enhanceSelection', () => enhanceSelection()),
  );
}

export function deactivate(): void {
  // Everything is disposed via context.subscriptions.
}
