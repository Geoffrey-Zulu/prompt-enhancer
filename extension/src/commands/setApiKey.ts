import * as vscode from 'vscode';

import { fetchModels, pickModel } from '../enhance/session.js';
import { log } from '../log.js';
import {
  createClient,
  detectProvider,
  IMPLEMENTED_PROVIDERS,
  isImplemented,
  looksLikeAnApiKey,
} from '../providers/registry.js';
import { PROVIDER_LABELS, type ProviderId } from '../providers/types.js';
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
      'Paste an Anthropic, OpenAI, or Google AI API key. The provider follows from the key itself. It is held in the OS credential store via VS Code SecretStorage, and is sent only to the provider it belongs to.',
    placeHolder: 'sk-ant-… · sk-… · AQ.… · AIza…',
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

  // A mis-paste — a sentence, a URL, an empty clipboard — fails here rather than
  // costing a round trip to a provider.
  if (!looksLikeAnApiKey(apiKey)) {
    log.warn('rejected input that is not key-shaped — nothing stored');
    void vscode.window.showErrorMessage(
      "Prompt Enhancer: that doesn't look like an API key. Nothing was stored.",
    );
    return;
  }

  // The prefix is a fast path, not a gate (§6). When it does not match anything
  // we know, ask — because the alternative is refusing a key that works, which
  // is precisely what happened when Google replaced its key format and this
  // extension only recognised the retired one.
  const provider = detectProvider(apiKey) ?? (await askWhichProvider());
  if (provider === undefined) {
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

/**
 * Asks which provider an unrecognised key belongs to.
 *
 * The prompt says why it is asking, because "we don't recognise this" reads as
 * "this is wrong" otherwise — and the whole point of this path is that the key is
 * probably fine and our table of prefixes is probably stale.
 */
async function askWhichProvider(): Promise<ProviderId | undefined> {
  log.info('key prefix not recognised — asking which provider it belongs to');

  const picked = await vscode.window.showQuickPick(
    IMPLEMENTED_PROVIDERS.map((provider) => ({
      label: PROVIDER_LABELS[provider],
      provider,
    })),
    {
      title: 'Prompt Enhancer: which provider is this key for?',
      placeHolder: 'The key format is unfamiliar — it will still be checked before it is stored',
      ignoreFocusOut: true,
    },
  );

  return picked?.provider;
}
