import { ApiError, type GenerateContentResponse, type Part } from '@google/genai';
import { describe, expect, it } from 'vitest';

import { answerParts, readAnswerText, toModelError } from './google.js';
import { CancelledError, ModelError, type ModelErrorKind } from './types.js';

const MODEL = 'a-model-id';

/** A response with the fields this adapter reads. */
function response(parts: Part[], extra: Partial<GenerateContentResponse> = {}): GenerateContentResponse {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    ...extra,
  } as GenerateContentResponse;
}

const thought: Part = { text: 'internal reasoning that must not escape', thought: true };
const answer: Part = { text: '# Role\nYou are…' };

describe('answerParts', () => {
  it('drops thinking parts, which on this provider look exactly like answer parts', () => {
    // The §6 reading rule that matters most here: a Gemini thought is a normal
    // text part carrying `thought: true`. A reader that concatenates every
    // `part.text` puts the model's reasoning into the user's file.
    expect(answerParts(response([thought, answer]))).toEqual(['# Role\nYou are…']);
    expect(answerParts(response([thought]))).toEqual([]);
  });

  it('ignores non-text parts and a missing candidate', () => {
    expect(answerParts(response([{ functionCall: { name: 'x', args: {} } }, answer]))).toEqual([
      '# Role\nYou are…',
    ]);
    expect(answerParts({} as GenerateContentResponse)).toEqual([]);
  });
});

describe('readAnswerText', () => {
  it('returns the answer and never the reasoning that came with it', () => {
    const result = readAnswerText(response([thought, answer]), MODEL);

    expect(result).toBe('# Role\nYou are…');
    expect(result).not.toContain('internal reasoning');
  });

  it('reports a blocked prompt as declined, before looking at any content', () => {
    // A prompt-level block comes back with no candidate at all, so a reader that
    // starts from the content sees an empty response and reports the wrong thing.
    expect(() =>
      readAnswerText(
        { promptFeedback: { blockReason: 'SAFETY' } } as GenerateContentResponse,
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'declined' satisfies ModelErrorKind }));
  });

  it('maps MAX_TOKENS to truncated even when partial text came back', () => {
    expect(() =>
      readAnswerText(response([{ text: 'half an ans' }], {
        candidates: [{ content: { role: 'model', parts: [{ text: 'half an ans' }] }, finishReason: 'MAX_TOKENS' }],
      } as Partial<GenerateContentResponse>), MODEL),
    ).toThrowError(expect.objectContaining({ kind: 'truncated' satisfies ModelErrorKind }));
  });

  it('maps every safety-shaped finish reason to declined', () => {
    for (const finishReason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']) {
      expect(() =>
        readAnswerText(
          {
            candidates: [{ content: { role: 'model', parts: [answer] }, finishReason }],
          } as unknown as GenerateContentResponse,
          MODEL,
        ),
        finishReason,
      ).toThrowError(expect.objectContaining({ kind: 'declined' satisfies ModelErrorKind }));
    }
  });

  it('fails rather than returning empty text', () => {
    // §9.1. The thought-only case is the one that matters: the response looks
    // successful and has text in it, but none of it is an answer.
    for (const parts of [[], [thought], [{ text: '  \n ' }]]) {
      expect(() => readAnswerText(response(parts), MODEL)).toThrowError(
        expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }),
      );
    }
  });

  it('rejects a finish reason it does not understand', () => {
    expect(() =>
      readAnswerText(
        {
          candidates: [{ content: { role: 'model', parts: [answer] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
        } as unknown as GenerateContentResponse,
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }));
  });
});

describe('toModelError', () => {
  const cases: Array<[number, ModelErrorKind]> = [
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'model_not_found'],
    [429, 'rate_limit'],
    [500, 'server'],
    [503, 'server'],
    [422, 'bad_request'],
  ];

  it.each(cases)('maps status %i to %s', (status, kind) => {
    // This SDK has one error class carrying a numeric status rather than a class
    // per status, so the §9.4 mapping switches on `error.status` — structured
    // data off a typed error, not a message-string match.
    const mapped = toModelError(new ApiError({ message: 'x', status }), { model: MODEL });

    expect(mapped).toBeInstanceOf(ModelError);
    expect((mapped as ModelError).kind).toBe(kind);
    expect((mapped as ModelError).provider).toBe('google');
  });

  it('separates a rejected key from a malformed request, which are both 400 here', () => {
    // Gemini answers a bad key with 400 INVALID_ARGUMENT, not 401. Without this
    // the user gets "the request was rejected" and no Set API Key button.
    const badKey = toModelError(
      new ApiError({ message: 'API key not valid. Please pass a valid API key.', status: 400 }),
      {},
    );
    expect((badKey as ModelError).kind).toBe('auth');

    const badRequest = toModelError(
      new ApiError({ message: 'Invalid value at contents[0]', status: 400 }),
      {},
    );
    expect((badRequest as ModelError).kind).toBe('bad_request');
  });

  it('treats an aborted fetch as a cancellation, not a failure', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';

    expect(toModelError(abort, { model: MODEL })).toBeInstanceOf(CancelledError);
  });

  it('reports a transport failure as offline', () => {
    const mapped = toModelError(new TypeError('fetch failed'), {});

    expect((mapped as ModelError).kind).toBe('offline');
  });

  it('passes our own errors through unchanged', () => {
    const ours = new ModelError('truncated', { provider: 'google' });
    expect(toModelError(ours, {})).toBe(ours);
  });
});
