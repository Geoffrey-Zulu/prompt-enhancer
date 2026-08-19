import * as vscode from 'vscode';

import { fetchModels, pickModel } from '../enhance/session.js';
import { log } from '../log.js';
import { createClient, detectProvider, isImplemented } from '../providers/registry.js';
import { PROVIDER_LABELS } from '../providers/types.js';
import type { Services } from '../services/index.js';

/**
 * "Prompt Enhancer: Set API Key" (TDD §7).
 *
 * Two things this command must never do, both structural rather than remembered:
 *
 * - **Never log or message the key.** The entered value is passed only to
 *   `detectProvider`, the adapter constructor, and `SecretService`. No message
 *   or log line in here interpolates it, and `log.ts` redacts regardless (§9.3).
 * - **Never store an invalid key silently.** The key is validated with one
 *   `listModels()` call *before* it is stored, and that same call populates the
 *   model quick-pick — one request, not two.
 */
export async function setApiKey(services: Services): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: 'Prompt Enhancer: Set API Key',
    prompt:
      'Paste your Anthropic API key. It is held in the OS credential store via VS Code SecretStorage, and is sent only to Anthropic.',
    placeHolder: 'sk-ant-…',
    password: true,
    ignoreFocusOut: true,
  });
  if (entered === undefined) {
    return;
  }

  const apiKey = entered.trim();
  if (apiKey.length === 0) {
    return;
  }

  // Provider follows from the key prefix (§6). An unrecognised shape is
  // rejected here rather than stored and left to fail later as a 401.
  const provider = detectProvider(apiKey);
  if (provider === undefined) {
    log.warn('rejected a key with an unrecognised prefix — nothing stored');
    void vscode.window.showErrorMessage(
      "Prompt Enhancer: that doesn't look like a supported API key. Nothing was stored.",
    );
    return;
  }

  if (!isImplemented(provider)) {
    log.warn(`rejected a ${provider} key — no adapter yet, nothing stored`);
    void vscode.window.showErrorMessage(
      `Prompt Enhancer: ${PROVIDER_LABELS[provider]} keys are not supported yet — support arrives with the other adapters. Nothing was stored.`,
    );
    return;
  }

  const label = PROVIDER_LABELS[provider];
  const client = createClient(provider, apiKey);

  // Validate on set (§7). `fetchModels` has already reported any failure.
  const models = await fetchModels(client, `Prompt Enhancer: checking your ${label} key…`);
  if (models === undefined) {
    log.warn(`${provider} key was not accepted — nothing stored`);
    return;
  }

  await services.secrets.setKey(provider, apiKey);
  log.info(`stored a ${provider} key; ${models.length} model(s) available`);

  const model = await pickModel(services, client, models);
  if (model === undefined) {
    void vscode.window.showInformationMessage(
      `Prompt Enhancer: ${label} key saved. You'll be asked to choose a model on first use.`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Prompt Enhancer: ${label} key saved — using ${model}.`,
  );
}
