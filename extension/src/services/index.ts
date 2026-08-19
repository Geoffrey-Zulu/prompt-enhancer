import type * as vscode from 'vscode';

import { ChoiceStore } from './ChoiceStore.js';
import { SecretService } from './SecretService.js';

export { ChoiceStore } from './ChoiceStore.js';
export { SecretService } from './SecretService.js';

/**
 * The state the commands and the shared orchestration need, built once in
 * `activate` and passed in explicitly. Nothing is held at module scope, so
 * there is no place for a key to be cached by accident (TDD §7).
 */
export interface Services {
  readonly secrets: SecretService;
  readonly choices: ChoiceStore;
}

export function createServices(context: vscode.ExtensionContext): Services {
  return {
    secrets: new SecretService(context.secrets),
    choices: new ChoiceStore(context.globalState),
  };
}
