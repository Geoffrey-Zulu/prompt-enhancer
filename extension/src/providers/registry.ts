import { AnthropicClient } from './anthropic.js';
import { GoogleClient } from './google.js';
import { OpenAIClient } from './openai.js';
import { type ModelClient, type ProviderId } from './types.js';

/**
 * Key-prefix detection and adapter construction (TDD §6).
 *
 * **This is the only file in the extension allowed to `switch` on provider.** A
 * `switch (provider)` anywhere else is a design failure — see §6.
 */

/** Every provider in the design (D2), in prefix-test order. */
export const ALL_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

/**
 * Providers with a working adapter. All three as of Phase 3 (D2), so this no
 * longer excludes anything — it stays because it is what `setApiKey` checks
 * before storing a key, and a fourth provider will arrive as an adapter before
 * it arrives as an entry here.
 */
export const IMPLEMENTED_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

export function isImplemented(provider: ProviderId): boolean {
  return IMPLEMENTED_PROVIDERS.includes(provider);
}

/**
 * Detects the provider from the key prefix (§6). Returns `undefined` for a key
 * shape we do not recognise, which the caller rejects at key-set time rather
 * than storing.
 *
 * **Order matters, and it is the one real trap here.** Anthropic keys also
 * begin `sk-`, so `sk-ant-` must be tested *first*. Getting this backwards
 * sends every Anthropic key to the OpenAI adapter, where it fails as a
 * confusing 401 rather than an obvious bug. `registry.test.ts` asserts it.
 */
export function detectProvider(apiKey: string): ProviderId | undefined {
  const key = apiKey.trim();

  if (key.startsWith('sk-ant-')) {
    return 'anthropic';
  }
  if (key.startsWith('AIza')) {
    return 'google';
  }
  if (key.startsWith('sk-')) {
    return 'openai';
  }
  return undefined;
}

/**
 * Builds the adapter for a provider. Called per enhancement from a key read per
 * call (§7) — the client is never held at module scope.
 */
export function createClient(provider: ProviderId, apiKey: string): ModelClient {
  switch (provider) {
    case 'anthropic':
      return new AnthropicClient(apiKey);
    case 'openai':
      return new OpenAIClient(apiKey);
    case 'google':
      return new GoogleClient(apiKey);
  }
}
