import type { RenderedPrompt } from '@prompt-enhancer/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpenAIClient } from './openai.js';

/**
 * The request contract, asserted against the SDK with global `fetch` replaced,
 * so what these tests inspect is the body that would actually go on the wire-
 * same approach as `anthropic.request.test.ts`, and for the same reason: none of
 * these rules is visible when reading the call site.
 */

const PROMPT: RenderedPrompt = { system: 'SYSTEM TEXT', user: 'USER TEXT' };
const MODEL = 'a-model-id';

interface Captured {
  url: string;
  body: Record<string, unknown>;
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

beforeEach(() => {
  captured = [];
  respondWith = () =>
    jsonResponse({
      id: 'resp_1',
      object: 'response',
      created_at: 0,
      model: MODEL,
      status: 'completed',
      error: null,
      incomplete_details: null,
      output: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'reasoning' }] },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '# Role\nYou are…', annotations: [] }],
        },
      ],
    });

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
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

function client(): OpenAIClient {
  return new OpenAIClient('sk-not-a-real-key');
}

describe('OpenAIClient.enhance- the request', () => {
  it('uses the Responses API with the system text in the instructions slot', async () => {
    await client().enhance(PROMPT, MODEL);

    const captured0 = captured[0];
    expect(captured0?.url).toContain('/responses');
    expect(captured0?.body['instructions']).toBe('SYSTEM TEXT');
    // §6: never concatenated into the user text.
    expect(captured0?.body['input']).toBe('USER TEXT');
  });

  it('sends no sampling parameters', async () => {
    await client().enhance(PROMPT, MODEL);

    const body = captured[0]?.body ?? {};
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('sends no reasoning effort, so a non-reasoning model is not a 400', async () => {
    // The model list this adapter offers includes non-reasoning models, and
    // `reasoning` is rejected on those- so pinning an effort would make the
    // user's model choice decide whether the extension worked at all.
    expect(captured).toHaveLength(0);
    await client().enhance(PROMPT, MODEL);
    expect(captured[0]?.body).not.toHaveProperty('reasoning');
  });

  it('opts out of response storage', async () => {
    await client().enhance(PROMPT, MODEL);

    // The API default is `store: true`, which would leave the user's selected
    // text in their OpenAI account. §13 promises the text goes to the provider
    // and nowhere else; retention is not part of that.
    expect(captured[0]?.body['store']).toBe(false);
  });

  it('sizes the budget for reasoning plus the answer and makes one request', async () => {
    await client().enhance(PROMPT, MODEL);

    expect(captured[0]?.body['max_output_tokens']).toBeGreaterThanOrEqual(16_000);
    expect(captured).toHaveLength(1);
  });

  it('returns the answer text and never the reasoning', async () => {
    const result = await client().enhance(PROMPT, MODEL);

    expect(result).toBe('# Role\nYou are…');
    expect(result).not.toContain('reasoning');
  });

  it('threads a cancellation signal down to the request', async () => {
    await client().enhance(PROMPT, MODEL, new AbortController().signal);

    expect(captured[0]?.signal).toBeDefined();
    expect(captured[0]?.signal).not.toBeNull();
  });

  it('surfaces an abort as a cancellation rather than a result', async () => {
    const cancel = new AbortController();
    cancel.abort();

    await expect(client().enhance(PROMPT, MODEL, cancel.signal)).rejects.toThrowError(
      expect.objectContaining({ name: 'CancelledError' }),
    );
  });

  it('maps a 401 to auth', async () => {
    respondWith = () => jsonResponse({ error: { message: 'bad key', type: 'invalid_request_error' } }, 401);

    await expect(client().enhance(PROMPT, MODEL)).rejects.toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
  });
});

describe('OpenAIClient.listModels', () => {
  function modelsResponse(ids: string[]): Response {
    return jsonResponse({
      object: 'list',
      data: ids.map((id, index) => ({
        id,
        object: 'model',
        created: index,
        owned_by: 'openai',
      })),
    });
  }

  it('drops non-text model families and puts the newest first', async () => {
    respondWith = () =>
      modelsResponse([
        'text-embedding-3-large',
        'whisper-1',
        'dall-e-3',
        'tts-1',
        'omni-moderation-latest',
        'a-chat-model',
        'a-newer-chat-model',
      ]);

    const models = await client().listModels();

    // Nothing here names a model (D9)- the filter excludes non-text
    // *modalities*, so an unfamiliar new text model still comes through.
    expect(models.map((model) => model.id)).toEqual(['a-newer-chat-model', 'a-chat-model']);
  });

  it('surfaces a rejected key as auth, so a bad key is never stored', async () => {
    respondWith = () => jsonResponse({ error: { message: 'bad key' } }, 401);

    await expect(client().listModels()).rejects.toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
  });
});
