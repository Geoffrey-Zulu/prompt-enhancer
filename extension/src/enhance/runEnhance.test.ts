import { MAX_ROUGH_TEXT_CHARS, PromptInputError, type RenderedPrompt } from '@prompt-enhancer/prompts';
import { describe, expect, it } from 'vitest';

import { ModelError, type ModelClient, type ModelInfo } from '../providers/types.js';
import { runEnhance } from './runEnhance.js';
import type { EnhanceSession } from './session.js';

interface Call {
  prompt: RenderedPrompt;
  model: string;
  aborted: boolean;
}

function session(reply: string | Error): { session: EnhanceSession; calls: Call[] } {
  const calls: Call[] = [];

  const client: ModelClient = {
    provider: 'anthropic',
    listModels: (): Promise<ModelInfo[]> => Promise.resolve([]),
    enhance: (prompt, model, signal): Promise<string> => {
      calls.push({ prompt, model, aborted: signal?.aborted ?? false });
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    enhanceStream: async function* (): AsyncIterable<string> {
      throw new Error('not used by the editor path (D8)');
    },
  };

  return { session: { client, provider: 'anthropic', model: 'a-model-id' }, calls };
}

describe('runEnhance', () => {
  it('enforces the input caps before any call is made', async () => {
    // §6: the caps are what stop a whole-file selection becoming a surprise
    // bill on the user's key, so they have to be enforced before the request,
    // not after it.
    const { session: s, calls } = session('should never be reached');

    await expect(
      runEnhance(s, { roughText: 'x'.repeat(MAX_ROUGH_TEXT_CHARS + 1), mode: 'code' }),
    ).rejects.toBeInstanceOf(PromptInputError);

    expect(calls).toHaveLength(0);
  });

  it('rejects empty text and an unknown mode without calling out', async () => {
    const { session: s, calls } = session('unreachable');

    await expect(runEnhance(s, { roughText: '   ', mode: 'code' })).rejects.toBeInstanceOf(
      PromptInputError,
    );
    await expect(
      // A closed enum (§5): an unknown mode is rejected before any network call.
      runEnhance(s, { roughText: 'fix the thing', mode: 'wishful' as 'code' }),
    ).rejects.toBeInstanceOf(PromptInputError);

    expect(calls).toHaveLength(0);
  });

  it('sends the system text in its own slot, never concatenated into the user text', async () => {
    const { session: s, calls } = session('# Role\nYou are a senior engineer…');

    const result = await runEnhance(s, { roughText: 'make login validate email', mode: 'code' });

    expect(result).toBe('# Role\nYou are a senior engineer…');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.model).toBe('a-model-id');
    expect(call?.prompt.system).toContain('prompt engineer');
    // §6: the system instruction goes in the provider's system slot. If it
    // leaked into the user text the model would treat it as content to rewrite.
    expect(call?.prompt.user).not.toContain('prompt engineer');
    expect(call?.prompt.user).toContain('make login validate email');
  });

  it('refuses an empty result rather than passing it to a caller that would write it', async () => {
    // §9.1. The adapter already guards this; runEnhance guards it again because
    // the cost of being wrong is the user's selection.
    const { session: s } = session('   \n\t ');

    await expect(runEnhance(s, { roughText: 'anything', mode: 'refactor' })).rejects.toThrowError(
      expect.objectContaining({ kind: 'bad_request' }),
    );
  });

  it('passes an already-cancelled signal straight through to the adapter', async () => {
    const { session: s, calls } = session('ignored');
    const cancel = new AbortController();
    cancel.abort();

    await runEnhance(s, { roughText: 'anything', mode: 'code' }, cancel.signal);

    // Cancellation is real, not cosmetic (§6): the adapter is handed an
    // already-aborted signal rather than being left to finish the request.
    expect(calls[0]?.aborted).toBe(true);
  });

  it('lets a provider failure through unchanged for the UI to map', async () => {
    const failure = new ModelError('rate_limit', { provider: 'anthropic', model: 'a-model-id' });
    const { session: s } = session(failure);

    await expect(runEnhance(s, { roughText: 'anything', mode: 'code' })).rejects.toBe(failure);
  });
});
