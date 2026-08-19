import { describe, expect, it } from 'vitest';

import { SecretService } from '../services/SecretService.js';
import { AnthropicClient } from './anthropic.js';
import { GoogleClient } from './google.js';
import { OpenAIClient } from './openai.js';
import {
  ALL_PROVIDERS,
  createClient,
  detectProvider,
  isImplemented,
  looksLikeAnApiKey,
} from './registry.js';

describe('detectProvider', () => {
  it('resolves an Anthropic key to Anthropic, not OpenAI', () => {
    // The one real trap in §6: Anthropic keys also begin `sk-`, so testing
    // `sk-` first routes every Anthropic key to the OpenAI adapter, where it
    // fails as a baffling 401 instead of an obvious bug.
    const key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    expect(detectProvider(key)).toBe('anthropic');
    expect(detectProvider(key)).not.toBe('openai');
    expect(createClient('anthropic', key)).toBeInstanceOf(AnthropicClient);
  });

  it('resolves the other two supported key shapes', () => {
    expect(detectProvider('sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB')).toBe('openai');
    expect(detectProvider('sk-CCCCCCCCCCCCCCCCCCCCCCCC')).toBe('openai');
    expect(detectProvider('AIzaDDDDDDDDDDDDDDDDDDDDDDDDDDDD')).toBe('google');
  });

  it('returns undefined for a shape it does not know, meaning "ask" not "invalid"', () => {
    // `detectProvider` is a fast path, not a gate. Google replacing its key
    // format mid-project is the proof: a prefix table is exactly as durable as a
    // hardcoded model ID. The caller asks the user rather than refusing, and the
    // real gate is validating against the provider before storing (§7).
    expect(detectProvider('')).toBeUndefined();
    expect(detectProvider('   ')).toBeUndefined();
    expect(detectProvider('hunter2')).toBeUndefined();
    expect(detectProvider('ghp_EEEEEEEEEEEEEEEEEEEE')).toBeUndefined();
    // Close but wrong: the prefix has to be at the start.
    expect(detectProvider('my key is sk-ant-api03-FFFF')).toBeUndefined();
  });

  it('tolerates whitespace around a pasted key', () => {
    expect(detectProvider('  sk-ant-api03-GGGGGGGGGGGGGGGG \n')).toBe('anthropic');
  });
});

describe('looksLikeAnApiKey', () => {
  it('catches a mis-paste without pretending to authenticate anything', () => {
    // The only job here is to stop obvious junk before it costs a round trip.
    expect(looksLikeAnApiKey('')).toBe(false);
    expect(looksLikeAnApiKey('   ')).toBe(false);
    expect(looksLikeAnApiKey('hunter2')).toBe(false);
    expect(looksLikeAnApiKey('my key is somewhere in my email')).toBe(false);
    expect(looksLikeAnApiKey('https://aistudio.google.com/apikey')).toBe(false);

    // Anything key-shaped gets through, whatever its prefix — including a format
    // that does not exist yet, which is the point.
    expect(looksLikeAnApiKey('AQ.Ab8RN6EEEEEEEEEEEEEEEEEEEEEEEE')).toBe(true);
    expect(looksLikeAnApiKey('sk-ant-api03-AAAAAAAAAAAAAAAA')).toBe(true);
    expect(looksLikeAnApiKey('  xy-2027-format-nobody-has-seen-yet  ')).toBe(true);
  });
});

describe('createClient', () => {
  it('routes each supported key shape to its own adapter', () => {
    // The end-to-end version of the ordering trap: it is not enough for
    // `detectProvider` to return 'anthropic', the key has to actually arrive at
    // the Anthropic adapter.
    const anthropic = createClient(
      detectProvider('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA') ?? 'openai',
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
    );
    expect(anthropic).toBeInstanceOf(AnthropicClient);
    expect(anthropic.provider).toBe('anthropic');

    const openai = createClient(
      detectProvider('sk-proj-BBBBBBBBBBBBBBBBBBBB') ?? 'anthropic',
      'sk-proj-BBBBBBBBBBBBBBBBBBBB',
    );
    expect(openai).toBeInstanceOf(OpenAIClient);
    expect(openai.provider).toBe('openai');

    for (const key of ['AIzaCCCCCCCCCCCCCCCCCCCC', 'AQ.Ab8RN6CCCCCCCCCCCCCCCCCC']) {
      const google = createClient(detectProvider(key) ?? 'anthropic', key);
      expect(google, key).toBeInstanceOf(GoogleClient);
      expect(google.provider).toBe('google');
    }
  });

  it('claims all three providers now that all three have an adapter', () => {
    for (const provider of ALL_PROVIDERS) {
      expect(isImplemented(provider), provider).toBe(true);
    }
  });

  it('gives every provider its own key slot, so keys never collide', () => {
    // §7: one key per provider, so a user with several keeps them all and
    // switching provider does not mean re-pasting.
    const slots = ALL_PROVIDERS.map((provider) => SecretService.storageKey(provider));

    expect(new Set(slots).size).toBe(ALL_PROVIDERS.length);
    for (const slot of slots) {
      expect(slot).toMatch(/^promptEnhancer\.apiKey\./);
    }
  });
});
