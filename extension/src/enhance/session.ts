import * as vscode from 'vscode';

import { log } from '../log.js';
import { createClient, isImplemented } from '../providers/registry.js';
import {
  isProviderId,
  ModelError,
  PROVIDER_LABELS,
  type ModelClient,
  type ModelInfo,
  type ProviderId,
} from '../providers/types.js';
import type { Services } from '../services/index.js';
import { withDeadline } from './deadline.js';
import { reportFailure, type Reporter } from './report.js';

/**
 * Resolving "which client, which model" (TDD §6, §7) — the first step of the
 * orchestration both entry points share, so Flow A and (in Phase 4) Flow B
 * cannot drift apart on key handling or model choice.
 *
 * Every function here returns `undefined` rather than throwing when the user
 * needs to act or has backed out, and has already told them why.
 */

export interface EnhanceSession {
  readonly client: ModelClient;
  readonly provider: ProviderId;
  /** Never a default: resolved from a setting, a stored choice, or a pick (D9). */
  readonly model: string;
}

export async function resolveSession(
  services: Services,
  report: Reporter = reportFailure,
): Promise<EnhanceSession | undefined> {
  const client = await resolveClient(services, report);
  if (client === undefined) {
    return undefined;
  }

  const model = await resolveModel(services, client, report);
  if (model === undefined) {
    return undefined;
  }

  return { client, provider: client.provider, model };
}

/**
 * Resolves the active provider and builds its adapter from a key read per call
 * (§7) — the client is constructed here and thrown away after, never held at
 * module scope and never built from `process.env`.
 *
 * Split out from `resolveSession` because "Select Model" needs a client in order
 * to list models but must not resolve a model first.
 */
export async function resolveClient(
  services: Services,
  report: Reporter = reportFailure,
): Promise<ModelClient | undefined> {
  const provider = await resolveProvider(services, report);
  if (provider === undefined) {
    return undefined;
  }

  const apiKey = await services.secrets.getKey(provider);
  if (apiKey === undefined) {
    await report(new ModelError('no_key', { provider }));
    return undefined;
  }

  return createClient(provider, apiKey);
}

/**
 * The active provider (§7), in order:
 *
 * 1. with exactly one key stored, that is the provider — no setting, no prompt;
 * 2. the `promptEnhancer.provider` setting, if it names a provider with a key;
 * 3. the remembered choice, if it still has a key;
 * 4. otherwise prompt once and remember.
 *
 * A setting naming a provider with no key stored is *ignored rather than
 * obeyed*: failing with "no key for OpenAI" when an Anthropic key is sitting
 * right there would be a worse answer than using the key the user has.
 */
async function resolveProvider(
  services: Services,
  report: Reporter,
): Promise<ProviderId | undefined> {
  const stored = (await services.secrets.storedProviders()).filter(isImplemented);

  const only = stored[0];
  if (only === undefined) {
    // Not an error — the user simply has not set up yet (§7).
    await report(new ModelError('no_key'));
    return undefined;
  }
  if (stored.length === 1) {
    return only;
  }

  const configured = vscode.workspace
    .getConfiguration('promptEnhancer')
    .get<string>('provider')
    ?.trim();
  if (configured !== undefined && isProviderId(configured) && stored.includes(configured)) {
    return configured;
  }

  const remembered = services.choices.getProvider();
  if (remembered !== undefined && stored.includes(remembered)) {
    return remembered;
  }

  const picked = await vscode.window.showQuickPick(
    stored.map((provider) => ({ label: PROVIDER_LABELS[provider], provider })),
    {
      title: 'Prompt Enhancer: which provider?',
      placeHolder: 'You have more than one key stored',
    },
  );
  if (picked === undefined) {
    return undefined;
  }
  await services.choices.setProvider(picked.provider);
  log.info(`active provider set to ${picked.provider}`);
  return picked.provider;
}

/**
 * Model resolution order (§6, D9):
 *
 * 1. the `promptEnhancer.model` setting, if set and non-empty;
 * 2. the choice stored for this provider;
 * 3. a quick-pick from `listModels()` on first use.
 *
 * The setting is **validated on use, not on write**, so a typo surfaces as
 * `model_not_found` with a Change Model action instead of being swallowed. That
 * validation is the provider's 404 on the real call — deliberately not a
 * pre-flight check, which would cost a request per enhancement.
 */
async function resolveModel(
  services: Services,
  client: ModelClient,
  report: Reporter,
): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration('promptEnhancer')
    .get<string>('model')
    ?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }

  const remembered = services.choices.getModel(client.provider);
  if (remembered !== undefined) {
    return remembered;
  }

  return pickModel(services, client, undefined, report);
}

/**
 * Fetches the models this key can use, under the §9.5 deadline and cancellable.
 * Returns `undefined` when it failed or was cancelled, having already reported.
 *
 * This is the same call that validates a key (§7) — one request confirms the
 * key *and* populates the quick-pick.
 */
export async function fetchModels(
  client: ModelClient,
  title: string,
  report: Reporter = reportFailure,
): Promise<ModelInfo[] | undefined> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (_progress, token) => {
        const cancel = new AbortController();
        const subscription = token.onCancellationRequested(() => cancel.abort());
        try {
          return await withDeadline(client.provider, cancel.signal, (signal) =>
            client.listModels(signal),
          );
        } finally {
          subscription.dispose();
        }
      },
    );
  } catch (error) {
    await report(error, { provider: client.provider });
    return undefined;
  }
}

/**
 * The quick-pick from `listModels()`, and the body of the "Select Model"
 * command. Stores the choice per provider so it is asked once, not every time.
 *
 * `models` is passed in by "Set API Key", which has just listed them as part of
 * validating the key — one request, not two (§7).
 */
export async function pickModel(
  services: Services,
  client: ModelClient,
  models?: ModelInfo[],
  report: Reporter = reportFailure,
): Promise<string | undefined> {
  const available =
    models ??
    (await fetchModels(
      client,
      `Prompt Enhancer: loading ${PROVIDER_LABELS[client.provider]} models…`,
      report,
    ));
  if (available === undefined) {
    return undefined;
  }
  if (available.length === 0) {
    await report(
      new ModelError('model_not_found', {
        provider: client.provider,
        detail: 'listModels returned an empty list',
      }),
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    available.map((model) => ({ label: model.label, description: model.id, id: model.id })),
    {
      title: `Prompt Enhancer: choose a ${PROVIDER_LABELS[client.provider]} model`,
      placeHolder: 'Models your key can use',
      matchOnDescription: true,
    },
  );
  if (picked === undefined) {
    return undefined;
  }

  await services.choices.setModel(client.provider, picked.id);
  log.info(`model for ${client.provider} set to ${picked.id}`);
  return picked.id;
}
