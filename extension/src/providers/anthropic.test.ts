import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { readAnswerText, toModelError } from './anthropic.js';
import { CancelledError, ModelError, TimeoutError, type ModelErrorKind } from './types.js';

const MODEL = 'a-model-id';

/**
 * A response with the fields this adapter reads. Cast because the full `Message`
 * type carries usage and container fields none of these tests are about; the
 * fields under test are all written out explicitly.
 */
function message(parts: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...parts,
  } as Anthropic.Message;
}

function thinking(text: string): Anthropic.ContentBlock {
  return { type: 'thinking', thinking: text, signature: 'sig' } as Anthropic.ContentBlock;
}

function text(value: string): Anthropic.ContentBlock {
  return { type: 'text', text: value, citations: null } as Anthropic.ContentBlock;
}

describe('readAnswerText', () => {
  it('joins the text blocks and never indexes block zero', () => {
    // §6 reading rule 1, and a live bug in rev 3 of the TDD: on a
    // reasoning-capable model the first block is usually internal reasoning, so
    // `content[0].text` returns the wrong thing- or reasoning- and on the
    // editor path that goes straight into the user's file.
    const result = readAnswerText(
      message({ content: [thinking('deliberating about the answer'), text('# Role\n'), text('You are…')] }),
      MODEL,
    );

    expect(result).toBe('# Role\nYou are…');
    expect(result).not.toContain('deliberating');
  });

  it('checks the stop reason before the content, so a refusal cannot be returned', () => {
    // §6 reading rule 3. The refusal below also carries text; returning it
    // would write a model's refusal over the user's selection.
    expect(() =>
      readAnswerText(
        message({
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: null },
          content: [text('I can not help with that.')],
        }),
        MODEL,
      ),
    ).toThrowError(expect.objectContaining({ kind: 'declined' satisfies ModelErrorKind }));
  });

  it('treats a truncated response as a failure, not a shorter answer', () => {
    for (const stopReason of ['max_tokens', 'model_context_window_exceeded'] as const) {
      expect(() =>
        readAnswerText(message({ stop_reason: stopReason, content: [text('half an ans')] }), MODEL),
      ).toThrowError(expect.objectContaining({ kind: 'truncated' satisfies ModelErrorKind }));
    }
  });

  it('fails rather than returning empty text', () => {
    // §9.1: writing an empty result over a selection destroys it.
    for (const content of [[], [thinking('only thought about it')], [text('   \n  ')]]) {
      expect(() => readAnswerText(message({ content }), MODEL)).toThrowError(
        expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }),
      );
    }
  });

  it('rejects a stop reason it does not understand', () => {
    for (const stopReason of ['tool_use', 'pause_turn', null] as const) {
      expect(() =>
        readAnswerText(message({ stop_reason: stopReason, content: [text('something')] }), MODEL),
      ).toThrowError(expect.objectContaining({ kind: 'bad_request' satisfies ModelErrorKind }));
    }
  });

  it('accepts a normal completion', () => {
    expect(readAnswerText(message({ content: [text('ok')], stop_reason: 'end_turn' }), MODEL)).toBe('ok');
    expect(readAnswerText(message({ content: [text('ok')], stop_reason: 'stop_sequence' }), MODEL)).toBe('ok');
  });
});

describe('toModelError', () => {
  const headers = new Headers();

  const cases: Array<[string, unknown, ModelErrorKind]> = [
    ['401', new Anthropic.AuthenticationError(401, undefined, 'bad key', headers), 'auth'],
    ['403', new Anthropic.PermissionDeniedError(403, undefined, 'nope', headers), 'forbidden'],
    ['404', new Anthropic.NotFoundError(404, undefined, 'no model', headers), 'model_not_found'],
    ['429', new Anthropic.RateLimitError(429, undefined, 'slow down', headers), 'rate_limit'],
    ['400', new Anthropic.BadRequestError(400, undefined, 'malformed', headers), 'bad_request'],
    ['500', new Anthropic.InternalServerError(500, undefined, 'boom', headers), 'server'],
    ['connection', new Anthropic.APIConnectionError({ message: 'ECONNREFUSED' }), 'offline'],
    ['other status', new Anthropic.APIError(418, undefined, 'teapot', headers), 'server'],
  ];

  it.each(cases)('maps a %s by its typed class, not its message', (_label, error, kind) => {
    // §9.4: mapping is by the SDK's typed error classes. None of these
    // assertions would survive being rewritten as message-string matches.
    const mapped = toModelError(error, { model: MODEL });

    expect(mapped).toBeInstanceOf(ModelError);
    expect((mapped as ModelError).kind).toBe(kind);
    expect((mapped as ModelError).provider).toBe('anthropic');
  });

  it('never puts the provider message in front of the user', () => {
    const mapped = toModelError(
      new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', headers),
      {},
    ) as ModelError;

    // The detail is for the output channel only (§9.7). The user sees the
    // §9.4 message, which `report.ts` builds from `kind`.
    expect(mapped.detail).toContain('invalid x-api-key');
  });

  it('maps an abort to a cancellation, which is not a failure', () => {
    expect(toModelError(new Anthropic.APIUserAbortError(), { model: MODEL })).toBeInstanceOf(
      CancelledError,
    );
  });

  it('maps a connection timeout to a timeout, not to offline', () => {
    expect(toModelError(new Anthropic.APIConnectionTimeoutError(), { model: MODEL })).toBeInstanceOf(
      TimeoutError,
    );
  });

  it('passes our own errors and genuine surprises through unchanged', () => {
    const ours = new ModelError('truncated', { provider: 'anthropic', model: MODEL });
    expect(toModelError(ours, { model: MODEL })).toBe(ours);

    const surprise = new TypeError('undefined is not a function');
    expect(toModelError(surprise, { model: MODEL })).toBe(surprise);
  });
});
