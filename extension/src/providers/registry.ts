import { AnthropicClient } from './anthropic.js';
import { GoogleClient } from './google.js';
import { OpenAIClient } from './openai.js';
import { type ModelClient, type ProviderId } from './types.js';

/**
 * Key-prefix detection and adapter construction (TDD §6).
 *
 * **This is the only file in the extension allowed to `switch` on provider.** A
 * `switch (provider)` anywhere else is a design failure- see §6.
 */

/** Every provider in the design (D2), in prefix-test order. */
export const ALL_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

/**
 * Providers with a working adapter. All three as of Phase 3 (D2), so this no
 * longer excludes anything- it stays because it is what `setApiKey` checks
 * before storing a key, and a fourth provider will arrive as an adapter before
 * it arrives as an entry here.
 */
export const IMPLEMENTED_PROVIDERS: readonly ProviderId[] = ['anthropic', 'openai', 'google'];

export function isImplemented(provider: ProviderId): boolean {
  return IMPLEMENTED_PROVIDERS.includes(provider);
}

/**
 * Every key prefix we recognise, in test order.
 *
 * **`sk-ant-` must come before `sk-`.** Anthropic keys also begin `sk-`, so the
 * general rule matching first sends every Anthropic key to the OpenAI adapter,
 * where it fails as a confusing 401 rather than an obvious bug.
 * `registry.test.ts` asserts the ordering.
 *
 * **Both Google prefixes are live.** `AQ.` is the authorization-key format AI
 * Studio now issues; `AIza` is the older standard-key format Google is retiring.
 * Recognising only `AIza`- which is what this table did originally- rejects
 * every Google key created today.
 */
const KEY_PREFIXES: ReadonlyArray<readonly [prefix: string, provider: ProviderId]> = [
  ['sk-ant-', 'anthropic'],
  ['AQ.', 'google'],
  ['AIza', 'google'],
  ['sk-', 'openai'],
];

/**
 * Detects the provider from the key prefix (§6)- a **fast path, not a gate.**
 *
 * `undefined` means "no idea", not "invalid". Provider key formats change:
 * Google replaced its entire format while this extension was being written, and
 * a table of prefixes is exactly as durable as a hardcoded model ID (D9). So an
 * unrecognised shape asks the user which provider it belongs to rather than
 * refusing it, and the real gate stays where it always was- a key is validated
 * against the provider before it is stored (§7).
 */
export function detectProvider(apiKey: string): ProviderId | undefined {
  const key = apiKey.trim();

  for (const [prefix, provider] of KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      return provider;
    }
  }
  return undefined;
}

/**
 * Whether a string could plausibly be an API key at all, independent of
 * provider. Catches a mis-paste- a sentence, a URL, an empty clipboard- so
 * that obvious junk fails immediately instead of reaching a provider.
 *
 * Deliberately weak: it is a sanity check, not an authenticator. Anything that
 * gets past it is still validated against the provider before being stored.
 */
export function looksLikeAnApiKey(candidate: string): boolean {
  const key = candidate.trim();
  if (key.length < 16 || /\s/.test(key)) {
    return false;
  }
  // Pasting the page you got the key from, rather than the key, is a real
  // mis-paste- and long enough with no spaces to pass everything above.
  return !key.includes('://');
}

/**
 * Builds the adapter for a provider. Called per enhancement from a key read per
 * call (§7)- the client is never held at module scope.
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
