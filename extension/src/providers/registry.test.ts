import { describe, expect, it } from 'vitest';

import { AnthropicClient } from './anthropic.js';
import { createClient, detectProvider, isImplemented } from './registry.js';

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

  it('rejects a key shape it does not recognise rather than guessing', () => {
    // Rejected at key-set time and never stored (§6) — a stored key that no
    // adapter can use is a support ticket with no useful error.
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

describe('createClient', () => {
  it('only claims the providers that actually have an adapter', () => {
    // Phase 2 ships one adapter (D2 build order). The unimplemented ones must
    // fail loudly here rather than being stored and failing at enhance time.
    expect(isImplemented('anthropic')).toBe(true);
    expect(isImplemented('openai')).toBe(false);
    expect(isImplemented('google')).toBe(false);

    expect(() => createClient('openai', 'sk-HHHHHHHHHHHHHHHHHHHH')).toThrow(/no adapter/i);
    expect(() => createClient('google', 'AIzaIIIIIIIIIIIIIIIIIIII')).toThrow(/no adapter/i);
  });
});
