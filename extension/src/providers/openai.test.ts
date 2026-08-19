import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';

import { readAnswerText, toModelError } from './openai.js';
import { CancelledError, ModelError, TimeoutError, type ModelErrorKind } from './types.js';

const MODEL = 'a-model-id';

/**
 * A Responses API response with the fields this adapter reads. Cast because the
 * full `Response` type carries usage, tool config, and a dozen other fields none
 * of these tests are about; everything under test is written out explicitly.
 */
function response(parts: Partial<OpenAI.Responses.Response>): OpenAI.Responses.Response {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: MODEL,
    status: 'completed',
    output: [],
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    ...parts,
  } as OpenAI.Responses.Response;
}

function reasoningItem(): OpenAI.Responses.ResponseOutputItem {
  return {
    type: 'reasoning',
    id: 'rs_1',
    summary: [{ type: 'summary_text', text: 'internal reasoning' }],
  } as OpenAI.Responses.ResponseOutputItem;
}

function messageItem(
  ...content: Array<{ type: 'output_text'; text: string } | { type: 'refusal'; refusal: string }>
): OpenAI.Responses.ResponseOutputItem {
  return {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: content.map((part) =>
      part.type === 'output_text' ? { ...part, annotations: [] } : part,
    ),
  } as OpenAI.Responses.ResponseOutputItem;
}

describe('readAnswerText', () => {
  it('skips the reasoning item and joins the message text', () => {
    // §6 reading rule 1. On a reasoning model `output[0]` is a `reasoning` item,
    // so anything that reaches for the first item gets reasoning, not an answer.
    const result = readAnswerText(
      response({
        output: [
          reasoningItem(),
          messageItem({ type: 'output_text', text: '# Role\n' }, { type: 'output_text', text: 'You are…' }),
        ],
      }),
      MODEL,
    );

    expect(result).toBe('# Role\nYou are…');
    expect(result).not.toContain('internal reasoning');
  });

  it('maps an incomplete response to truncated or declined by its reason', () => {
    // §6 reading rule 3, checked before the content is touched- both of these
    // carry partial text that must never reach the document.
    expect(() =>
      readAnswerText(
        response({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [messageItem({ type: 'output_text', text: 'half an ans' })],
        }),
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'truncated' satisfies ModelErrorKind }));

    expect(() =>
      readAnswerText(
        response({
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          output: [messageItem({ type: 'output_text', text: 'partial' })],
        }),
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'declined' satisfies ModelErrorKind }));
  });

  it('reports a refusal as declined rather than as an empty result', () => {
    expect(() =>
      readAnswerText(
        response({ output: [messageItem({ type: 'refusal', refusal: 'I will not do that.' })] }),
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'declined' satisfies ModelErrorKind }));
  });

  it('fails on a failed response and on an empty one', () => {
    expect(() =>
      readAnswerText(
        response({ status: 'failed', error: { code: 'server_error', message: 'boom' } }),
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }));

    // §9.1: an empty result is a failure, never something written over a selection.
    for (const output of [[], [reasoningItem()], [messageItem({ type: 'output_text', text: '  \n ' })]]) {
      expect(() => readAnswerText(response({ output }), MODEL)).toThrowError(
        expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }),
      );
    }
  });

  it('rejects a status it does not understand', () => {
    expect(() =>
      readAnswerText(
        response({ status: 'in_progress', output: [messageItem({ type: 'output_text', text: 'x' })] }),
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }));
  });
});

describe('toModelError', () => {
  const headers = new Headers();

  const cases: Array<[string, unknown, ModelErrorKind]> = [
    ['401', new OpenAI.AuthenticationError(401, undefined, 'bad key', headers), 'auth'],
    ['403', new OpenAI.PermissionDeniedError(403, undefined, 'nope', headers), 'forbidden'],
    ['404', new OpenAI.NotFoundError(404, undefined, 'no model', headers), 'model_not_found'],
    ['429', new OpenAI.RateLimitError(429, undefined, 'slow down', headers), 'rate_limit'],
    ['400', new OpenAI.BadRequestError(400, undefined, 'malformed', headers), 'bad_request'],
    ['500', new OpenAI.InternalServerError(500, undefined, 'boom', headers), 'server'],
    ['connection', new OpenAI.APIConnectionError({ message: 'ECONNREFUSED' }), 'offline'],
    ['other status', new OpenAI.APIError(418, undefined, 'teapot', headers), 'server'],
  ];

  it.each(cases)('maps a %s by its typed class, not its message', (_label, error, kind) => {
    const mapped = toModelError(error, { model: MODEL });

    expect(mapped).toBeInstanceOf(ModelError);
    expect((mapped as ModelError).kind).toBe(kind);
    expect((mapped as ModelError).provider).toBe('openai');
  });

  it('separates a cancellation and a timeout from provider failures', () => {
    expect(toModelError(new OpenAI.APIUserAbortError(), {})).toBeInstanceOf(CancelledError);
    expect(toModelError(new OpenAI.APIConnectionTimeoutError(), {})).toBeInstanceOf(TimeoutError);
  });

  it('passes our own errors and genuine surprises through unchanged', () => {
    const ours = new ModelError('truncated', { provider: 'openai' });
    expect(toModelError(ours, {})).toBe(ours);

    const surprise = new TypeError('undefined is not a function');
    expect(toModelError(surprise, {})).toBe(surprise);
  });
});
