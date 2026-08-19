import * as vscode from 'vscode';

import { describeFailure, reportFailure, type Reporter } from '../enhance/report.js';
import { fetchModels, pickModel } from '../enhance/session.js';
import { log } from '../log.js';
import {
  createClient,
  detectProvider,
  IMPLEMENTED_PROVIDERS,
  isImplemented,
  looksLikeAnApiKey,
} from '../providers/registry.js';
import { ModelError, PROVIDER_LABELS, type ModelInfo, type ProviderId } from '../providers/types.js';
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
 *   model quick-pick- one request, not two.
 */
export async function setApiKey(services: Services): Promise<void> {
  const entered = await vscode.window.showInputBox({
    title: 'Prompt Enhancer: Set API Key',
    prompt:
      'Paste an Anthropic, OpenAI, or Google AI API key. The provider is worked out from the key, and you are asked if it cannot be. The key is held in the OS credential store via VS Code SecretStorage, and is sent only to the provider it belongs to.',
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

  // A mis-paste- a sentence, a URL, an empty clipboard- fails here rather than
  // costing a round trip to a provider.
  if (!looksLikeAnApiKey(apiKey)) {
    log.warn('rejected input that is not key-shaped- nothing stored');
    void vscode.window.showErrorMessage(
      "Prompt Enhancer: that doesn't look like an API key. Nothing was stored.",
    );
    return;
  }

  // The prefix is a fast path, not a gate (§6). When it does not match anything
  // we know, ask- because the alternative is refusing a key that works, which
  // is precisely what happened when Google replaced its key format and this
  // extension only recognised the retired one.
  const detected = detectProvider(apiKey);
  let provider = detected ?? (await askWhichProvider());
  if (provider === undefined) {
    return;
  }

  let attempt = await validate(provider, apiKey);

  // **A guess that fails is worth one question, not a dead end.** Recognising a
  // prefix says nothing about being right: if a provider ever ships a format that
  // collides with another's, detection routes the key to the wrong adapter and the
  // user sees a flat "your key was rejected" for a key that is perfectly good.
  // Since the guess is already being checked against the provider, letting a
  // rejection re-open the question makes a mis-guess self-correcting- and costs
  // nothing on the path where the guess was right.
  if (attempt.models === undefined && detected !== undefined && isRoutingFailure(attempt.error)) {
    log.warn(`${detected} rejected the key; the prefix may have routed it wrongly`);
    const corrected = await askWhichProvider(
      `${PROVIDER_LABELS[detected]} rejected that key- is it for a different provider?`,
    );
    if (corrected === undefined) {
      await reportFailure(attempt.error, { provider });
      return;
    }
    if (corrected !== provider) {
      provider = corrected;
      attempt = await validate(provider, apiKey);
    }
  }

  const models = attempt.models;
  if (models === undefined) {
    log.warn(`${provider} key was not accepted- nothing stored`);
    await reportFailure(attempt.error, { provider });
    return;
  }

  const label = PROVIDER_LABELS[provider];
  await services.secrets.setKey(provider, apiKey);
  log.info(`stored a ${provider} key; ${models.length} model(s) available`);

  const model = await pickModel(services, createClient(provider, apiKey), models);
  if (model === undefined) {
    void vscode.window.showInformationMessage(
      `Prompt Enhancer: ${label} key saved. You'll be asked to choose a model on first use.`,
    );
    return;
  }

  void vscode.window.showInformationMessage(
    `Prompt Enhancer: ${label} key saved- using ${model}.`,
  );
}

/**
 * Asks which provider an unrecognised key belongs to.
 *
 * The prompt says why it is asking, because "we don't recognise this" reads as
 * "this is wrong" otherwise- and the whole point of this path is that the key is
 * probably fine and our table of prefixes is probably stale.
 */
async function askWhichProvider(placeHolder?: string): Promise<ProviderId | undefined> {
  log.info('asking which provider the key belongs to');

  const picked = await vscode.window.showQuickPick(
    IMPLEMENTED_PROVIDERS.map((provider) => ({
      label: PROVIDER_LABELS[provider],
      provider,
    })),
    {
      title: 'Prompt Enhancer: which provider is this key for?',
      placeHolder:
        placeHolder ??
        'The key format is unfamiliar- it will still be checked before it is stored',
      ignoreFocusOut: true,
    },
  );

  return picked?.provider;
}

interface ValidationAttempt {
  models: ModelInfo[] | undefined;
  error: unknown;
}

/**
 * One `listModels()` call: confirms the key works *and* populates the model
 * quick-pick (§7). Nothing is stored until this succeeds.
 *
 * Failures are captured rather than shown, because this may be called twice- a
 * rejected guess re-opens the provider question- and reporting each attempt
 * would put two error toasts in front of the user for one key.
 */
async function validate(provider: ProviderId, apiKey: string): Promise<ValidationAttempt> {
  if (!isImplemented(provider)) {
    return {
      models: undefined,
      error: new ModelError('bad_request', {
        provider,
        detail: 'no adapter for this provider yet',
      }),
    };
  }

  let captured: unknown;
  const capture: Reporter = (error) => {
    captured = error;
    // Still logged, with the key-redacting channel doing its job (§9.3).
    describeFailure(error, { provider });
    return Promise.resolve();
  };

  const models = await fetchModels(
    createClient(provider, apiKey),
    `Prompt Enhancer: checking your ${PROVIDER_LABELS[provider]} key…`,
    capture,
  );

  return { models, error: captured };
}

/**
 * Whether a failure could plausibly mean "this key belongs to someone else"
 * rather than "this key is broken".
 *
 * Only auth and permission failures qualify. Being offline or rate limited says
 * nothing about which provider a key is for, and asking would be noise.
 */
function isRoutingFailure(error: unknown): boolean {
  return error instanceof ModelError && (error.kind === 'auth' || error.kind === 'forbidden');
}
