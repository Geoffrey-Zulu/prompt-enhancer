import type { RenderedPrompt } from '@prompt-enhancer/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnthropicClient } from './anthropic.js';
import { ModelError } from './types.js';

/**
 * The request contract, asserted against the SDK rather than around it: these
 * tests drive `AnthropicClient` with the global `fetch` replaced, so what they
 * inspect is the body that would actually go on the wire.
 *
 * They exist because the §6 request rules are all invisible in a code review of
 * the call site- a stray `temperature`, a disabled `thinking`, or a system
 * prompt folded into the user turn all look perfectly reasonable.
 */

const PROMPT: RenderedPrompt = { system: 'SYSTEM TEXT', user: 'USER TEXT' };
const MODEL = 'a-model-id';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
  signal: AbortSignal | null | undefined;
}

let captured: Captured[] = [];
let respondWith: () => Response;
const realFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function messagePayload(content: unknown[], stopReason: string | null = 'end_turn'): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

beforeEach(() => {
  captured = [];
  respondWith = () =>
    jsonResponse(
      messagePayload([
        { type: 'thinking', thinking: 'internal reasoning that must not escape', signature: 'sig' },
        { type: 'text', text: '# Role\nYou are…', citations: null },
      ]),
    );

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: new Headers(init?.headers),
      signal: init?.signal,
    });
    // Behave like the real `fetch`: an aborted signal rejects with an
    // AbortError rather than being quietly ignored. Without this the stub makes
    // cancellation look like it works whether or not the SDK forwards it.
    if (init?.signal?.aborted === true) {
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    return respondWith();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): AnthropicClient {
  return new AnthropicClient('sk-ant-not-a-real-key');
}

describe('AnthropicClient.enhance- the request', () => {
  it('sends no sampling parameters at all', async () => {
    await client().enhance(PROMPT, MODEL);

    const body = captured[0]?.body ?? {};
    // §6: `claude-opus-5` rejects these with a 400, and several reasoning
    // models elsewhere restrict them. Omitting them is correct everywhere.
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('leaves thinking enabled and spends less by lowering effort instead', async () => {
    await client().enhance(PROMPT, MODEL);

    // With thinking off this model can emit reasoning markup into the visible
    // response, and on the editor path that lands in the user's file (§6).
    expect(captured[0]?.body['thinking']).toEqual({ type: 'adaptive' });
    expect(captured[0]?.body['output_config']).toEqual({ effort: 'low' });
  });

  it('puts the system text in the system slot with a cache breakpoint on it', async () => {
    await client().enhance(PROMPT, MODEL);

    const body = captured[0]?.body ?? {};
    expect(body['system']).toEqual([
      { type: 'text', text: 'SYSTEM TEXT', cache_control: { type: 'ephemeral' } },
    ]);
    // Never concatenated into the user text (§6).
    expect(body['messages']).toEqual([{ role: 'user', content: 'USER TEXT' }]);
    expect(JSON.stringify(body['messages'])).not.toContain('SYSTEM TEXT');
  });

  it('passes the model through and sizes the budget for reasoning plus answer', async () => {
    await client().enhance(PROMPT, MODEL);

    expect(captured[0]?.body['model']).toBe(MODEL);
    expect(captured[0]?.body['max_tokens']).toBeGreaterThanOrEqual(16_000);
  });

  it('makes exactly one request- no retry layer of ours wraps the SDK', async () => {
    await client().enhance(PROMPT, MODEL);
    expect(captured).toHaveLength(1);
  });
});

describe('AnthropicClient.enhance- the response', () => {
  it('returns the answer text and never the reasoning that precedes it', async () => {
    const result = await client().enhance(PROMPT, MODEL);

    expect(result).toBe('# Role\nYou are…');
    expect(result).not.toContain('internal reasoning');
  });

  it('maps a 401 to auth by the SDK error class', async () => {
    respondWith = () =>
      jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'x' } }, 401);

    await expect(client().enhance(PROMPT, MODEL)).rejects.toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
  });

  it('maps a 404 to model_not_found, which is how a bad model setting surfaces', async () => {
    respondWith = () =>
      jsonResponse({ type: 'error', error: { type: 'not_found_error', message: 'x' } }, 404);

    await expect(client().enhance(PROMPT, 'no-such-model')).rejects.toThrowError(
      expect.objectContaining({ kind: 'model_not_found', model: 'no-such-model' }),
    );
  });

  it('refuses a refusal instead of writing it over the selection', async () => {
    respondWith = () =>
      jsonResponse(
        messagePayload([{ type: 'text', text: 'I will not do that.', citations: null }], 'refusal'),
      );

    await expect(client().enhance(PROMPT, MODEL)).rejects.toThrowError(
      expect.objectContaining({ kind: 'declined' }),
    );
  });

  it('threads a cancellation signal down to the request', async () => {
    // §6 wants cancellation real rather than cosmetic, so the assertion is that
    // a signal reaches `fetch`- not merely that something rejected.
    await client().enhance(PROMPT, MODEL, new AbortController().signal);

    expect(captured[0]?.signal).toBeDefined();
    expect(captured[0]?.signal).not.toBeNull();
  });

  it('surfaces an abort as a cancellation, not as a provider failure or a result', async () => {
    const cancel = new AbortController();
    cancel.abort();

    const attempt = client().enhance(PROMPT, MODEL, cancel.signal);
    await expect(attempt).rejects.toThrowError(
      expect.objectContaining({ name: 'CancelledError' }),
    );
    await expect(attempt).rejects.not.toBeInstanceOf(ModelError);
  });
});

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AnthropicClient.enhanceStream', () => {
  /** A stream that interleaves a thinking block with the answer text. */
  function reasoningThenText(stopReason = 'end_turn'): Array<Record<string, unknown>> {
    return [
      { type: 'message_start', message: messagePayload([], null) },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'internal reasoning' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '# Role\n' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'You are…' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ];
  }

  it('yields text deltas only, never reasoning deltas', async () => {
    respondWith = () => sseResponse(reasoningThenText());

    const chunks: string[] = [];
    for await (const chunk of client().enhanceStream(PROMPT, MODEL)) {
      chunks.push(chunk);
    }

    // §6: each adapter filters its provider's non-text events out of the
    // stream. A leaked thinking delta would render as reasoning in the chat.
    expect(chunks).toEqual(['# Role\n', 'You are…']);
    expect(chunks.join('')).not.toContain('internal reasoning');
    expect(captured[0]?.body['stream']).toBe(true);
  });

  it('checks the terminal stop reason before the consumer can trust the result', async () => {
    respondWith = () => sseResponse(reasoningThenText('max_tokens'));

    const iterate = async (): Promise<void> => {
      for await (const _chunk of client().enhanceStream(PROMPT, MODEL)) {
        // The deltas arrive; the failure is raised at the end of the stream.
      }
    };

    await expect(iterate()).rejects.toThrowError(expect.objectContaining({ kind: 'truncated' }));
  });
});

describe('AnthropicClient.listModels', () => {
  it('reads ids and display names from the models endpoint', async () => {
    respondWith = () =>
      jsonResponse({
        data: [
          { type: 'model', id: 'model-b', display_name: 'Model B', created_at: '2026-01-01' },
          { type: 'model', id: 'model-a', display_name: 'Model A', created_at: '2025-01-01' },
        ],
        has_more: false,
        first_id: null,
        last_id: null,
      });

    const models = await client().listModels();

    expect(models).toEqual([
      { id: 'model-b', label: 'Model B' },
      { id: 'model-a', label: 'Model A' },
    ]);
    // Discovery, never a hardcoded list (D9).
    expect(captured[0]?.url).toContain('/v1/models');
  });

  it('surfaces a rejected key as auth, so a bad key is never stored', async () => {
    respondWith = () =>
      jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'x' } }, 401);

    await expect(client().listModels()).rejects.toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
  });
});
