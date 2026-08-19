import type { RenderedPrompt } from '@prompt-enhancer/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GoogleClient } from './google.js';

/**
 * The request contract, asserted against the SDK with global `fetch` replaced-
 * same approach as the other two adapters' request suites.
 */

const PROMPT: RenderedPrompt = { system: 'SYSTEM TEXT', user: 'USER TEXT' };
const MODEL = 'a-model-id';
const FAKE_KEY = 'AIzaNotARealKeyJustForTests';

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

function candidate(parts: unknown[], finishReason = 'STOP'): unknown {
  return { candidates: [{ content: { role: 'model', parts }, finishReason }] };
}

beforeEach(() => {
  captured = [];
  respondWith = () =>
    jsonResponse(
      candidate([
        { text: 'internal reasoning that must not escape', thought: true },
        { text: '# Role\nYou are…' },
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
    // AbortError rather than being quietly ignored. Without this the stub would
    // make cancellation look like it worked whether or not the SDK forwards the
    // signal at all.
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

function client(): GoogleClient {
  return new GoogleClient(FAKE_KEY);
}

describe('GoogleClient.enhance- the request', () => {
  it('puts the system text in systemInstruction, not in the contents', async () => {
    await client().enhance(PROMPT, MODEL);

    const body = captured[0]?.body ?? {};
    expect(body['systemInstruction']).toEqual({
      role: 'user',
      parts: [{ text: 'SYSTEM TEXT' }],
    });
    // §6: never concatenated into the user turn.
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'USER TEXT' }] }]);
    expect(JSON.stringify(body['contents'])).not.toContain('SYSTEM TEXT');
  });

  it('sends no sampling parameters and no thinking budget', async () => {
    await client().enhance(PROMPT, MODEL);

    const generationConfig = captured[0]?.body['generationConfig'];
    // §6: no temperature / topP / topK. And no `thinkingConfig`: the model's own
    // default is the safe setting, and pinning a budget would be the same
    // mistake as pinning a model ID- the right number changes per model.
    expect(generationConfig).toEqual({ maxOutputTokens: 32_000 });
  });

  it('keeps the key out of the request URL', async () => {
    await client().enhance(PROMPT, MODEL);

    // Not a style point: a URL ends up in exception messages and proxy logs far
    // more easily than a header does (§7).
    expect(captured[0]?.url).not.toContain(FAKE_KEY);
    expect(captured[0]?.url).toContain(`models/${MODEL}:generateContent`);
  });

  it('makes exactly one request- no retry layer of ours', async () => {
    await client().enhance(PROMPT, MODEL);
    expect(captured).toHaveLength(1);
  });
});

describe('GoogleClient.enhance- the response', () => {
  it('returns the answer and drops the thinking part that came with it', async () => {
    const result = await client().enhance(PROMPT, MODEL);

    expect(result).toBe('# Role\nYou are…');
    expect(result).not.toContain('internal reasoning');
  });

  it('maps a rejected key to auth even though Gemini answers it with a 400', async () => {
    respondWith = () =>
      jsonResponse(
        {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
          },
        },
        400,
      );

    await expect(client().enhance(PROMPT, MODEL)).rejects.toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
  });

  it('maps an unknown model to model_not_found', async () => {
    respondWith = () =>
      jsonResponse({ error: { code: 404, message: 'models/x is not found', status: 'NOT_FOUND' } }, 404);

    await expect(client().enhance(PROMPT, 'no-such-model')).rejects.toThrowError(
      expect.objectContaining({ kind: 'model_not_found' }),
    );
  });

  it('refuses a safety-blocked response instead of writing it over the selection', async () => {
    respondWith = () => jsonResponse(candidate([{ text: 'partial' }], 'SAFETY'));

    await expect(client().enhance(PROMPT, MODEL)).rejects.toThrowError(
      expect.objectContaining({ kind: 'declined' }),
    );
  });

  it('forwards the abort signal to the request, so cancellation is real', async () => {
    const cancel = new AbortController();
    cancel.abort();

    await expect(client().enhance(PROMPT, MODEL, cancel.signal)).rejects.toThrowError(
      expect.objectContaining({ name: 'CancelledError' }),
    );

    // §6 wants cancellation threaded to the underlying request rather than
    // cosmetic, so the assertion is that the signal reached `fetch`- not just
    // that something rejected.
    expect(captured[0]?.signal?.aborted).toBe(true);
  });
});

describe('GoogleClient.listModels', () => {
  it('keeps content-generating models and strips the models/ prefix', async () => {
    respondWith = () =>
      jsonResponse({
        models: [
          {
            name: 'models/a-chat-model',
            displayName: 'A Chat Model',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/an-embedding-model',
            displayName: 'An Embedding Model',
            supportedGenerationMethods: ['embedContent'],
          },
          // No reported actions at all: kept rather than hidden, because the
          // filter is an exclusion- a model the API stops describing should
          // still be selectable (see the same reasoning in `openai.ts`).
          { name: 'models/an-undescribed-model', displayName: 'Undescribed' },
        ],
      });

    const models = await client().listModels();

    expect(models).toEqual([
      { id: 'a-chat-model', label: 'A Chat Model' },
      { id: 'an-undescribed-model', label: 'Undescribed' },
    ]);
  });

  it('surfaces a rejected key as auth, so a bad key is never stored', async () => {
    respondWith = () =>
      jsonResponse(
        { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' } },
        400,
      );

    await expect(client().listModels()).rejects.toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
  });
});
