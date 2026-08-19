import * as vscode from 'vscode';

import { pickModel, resolveClient } from '../enhance/session.js';
import type { Services } from '../services/index.js';

/**
 * "Prompt Enhancer: Select Model" (TDD §6)- re-runs the quick-pick against the
 * active key, so changing model never requires hand-editing settings.
 *
 * The stored choice is step 2 of the resolution order, so a non-empty
 * `promptEnhancer.model` setting still wins on the next enhancement. Saying so
 * here is cheaper than a support question about why the pick "did nothing".
 */
export async function selectModel(services: Services): Promise<void> {
  const client = await resolveClient(services);
  if (client === undefined) {
    return;
  }

  const model = await pickModel(services, client);
  if (model === undefined) {
    return;
  }

  const configured = vscode.workspace
    .getConfiguration('promptEnhancer')
    .get<string>('model')
    ?.trim();

  if (configured !== undefined && configured.length > 0 && configured !== model) {
    void vscode.window.showWarningMessage(
      `Prompt Enhancer: saved ${model}, but the promptEnhancer.model setting is \`${configured}\` and takes precedence. Clear the setting to use the model you just picked.`,
    );
    return;
  }

  void vscode.window.showInformationMessage(`Prompt Enhancer: using ${model}.`);
}
