import * as vscode from 'vscode';

import { log } from '../log.js';
import { PROVIDER_LABELS, type ProviderId } from '../providers/types.js';
import type { Services } from '../services/index.js';

/**
 * "Prompt Enhancer: Clear API Key" (TDD §7) — quick-pick which provider, or
 * all. Clearing removes the key and forgets the model chosen with it; the
 * extension then prompts on next use rather than failing obscurely.
 */
export async function clearApiKey(services: Services): Promise<void> {
  const stored = await services.secrets.storedProviders();

  if (stored.length === 0) {
    void vscode.window.showInformationMessage('Prompt Enhancer: no API key is stored.');
    return;
  }

  interface Item extends vscode.QuickPickItem {
    providers: ProviderId[];
  }

  const items: Item[] = stored.map((provider) => ({
    label: PROVIDER_LABELS[provider],
    providers: [provider],
  }));
  if (stored.length > 1) {
    items.push({ label: 'All providers', providers: [...stored] });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Prompt Enhancer: Clear API Key',
    placeHolder: 'Which key should be removed?',
  });
  if (picked === undefined) {
    return;
  }

  for (const provider of picked.providers) {
    await services.secrets.deleteKey(provider);
    // The model choice belonged to that key, so it goes with it.
    await services.choices.forgetModel(provider);
    log.info(`cleared the ${provider} key`);
  }

  const cleared = picked.providers.map((provider) => PROVIDER_LABELS[provider]).join(', ');
  void vscode.window.showInformationMessage(`Prompt Enhancer: cleared ${cleared}.`);
}
