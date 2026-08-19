import Anthropic from '@anthropic-ai/sdk';
import type { RenderedPrompt } from '@prompt-enhancer/prompts';

import {
  CancelledError,
  ModelError,
  REQUEST_TIMEOUT_MS,
  TimeoutError,
  type ModelClient,
  type ModelInfo,
} from './types.js';

/**
 * The Anthropic adapter (TDD §6). It normalises; it does not leak- nothing
 * outside this file knows the Anthropic wire format, its stop reasons, or its
 * error classes.
 *
 * **No model ID appears here** (D9). The model is always passed in, resolved
 * from `listModels()` or the `promptEnhancer.model` setting.
 */

const PROVIDER = 'anthropic' as const;

/**
 * The cap covers internal reasoning **plus** the answer, so it is sized for
 * both rather than tight around the answer (§6). An enhanced prompt is a few
 * hundred tokens; the rest is headroom for thinking.
 */
const MAX_OUTPUT_TOKENS = 16_000;

/** How many models one `listModels` request returns. Well above the catalogue. */
const MODEL_PAGE_SIZE = 100;

export class AnthropicClient implements ModelClient {
  readonly provider = PROVIDER;

  private readonly sdk: Anthropic;

  /**
   * Constructed per call from a key read per call (§7)- never at module
   * scope, and never from `process.env`, so a key in the developer's
   * environment cannot silently stand in for the user's.
   */
  constructor(apiKey: string) {
    this.sdk = new Anthropic({
      apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      // The SDK already retries 429 and 5xx with backoff. Wrapping a second
      // retry layer around it is explicitly wrong (§9.4)- an error reaching
      // the caller means retries are exhausted.
    });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const page = await this.sdk.models.list({ limit: MODEL_PAGE_SIZE }, { signal });
      return page.data.map((model) => ({ id: model.id, label: model.display_name }));
    } catch (error) {
      throw toModelError(error, {});
    }
  }

  async enhance(prompt: RenderedPrompt, model: string, signal?: AbortSignal): Promise<string> {
    let message: Anthropic.Message;
    try {
      message = await this.sdk.messages.create(
        {
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          // System text goes in the provider's system slot, never concatenated
          // into the user text (§6). Prompt caching sits on this block only,
          // and nothing volatile is interpolated into it- the rendered system
          // text is byte-identical across enhancements in the same mode, or
          // caching would silently stop.
          system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt.user }],
          // Thinking stays ON. With it off this model can leak reasoning
          // markup into the visible response, and on the editor path that goes
          // straight into the user's file (§6, reading rule 2). Effort is the
          // cost dial instead.
          thinking: { type: 'adaptive' },
          output_config: { effort: 'low' },
          // No temperature / top_p / top_k on any provider (§6). They are
          // rejected outright here, and the template steers output shape.
        },
        { signal },
      );
    } catch (error) {
      throw toModelError(error, { model });
    }

    return readAnswerText(message, model);
  }

  async *enhanceStream(
    prompt: RenderedPrompt,
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const stream = this.sdk.messages.stream(
      {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: prompt.user }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      },
      { signal },
    );

    try {
      for await (const event of stream) {
        // Text deltas only- thinking deltas and every other event are
        // filtered out here, so no reasoning can reach the consumer (§6).
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
      // The terminal stop reason is checked before the consumer may treat the
      // result as complete (§6). Deltas already yielded are the consumer's to
      // discard- which is one reason the editor path does not stream (D8).
      assertUsableStopReason(await stream.finalMessage(), model);
    } catch (error) {
      throw toModelError(error, { model });
    }
  }
}

/**
 * Exported for unit tests: this is the §6 "reading the response" contract, and
 * each of its three rules exists because of a real failure mode.
 */
export function readAnswerText(message: Anthropic.Message, model: string): string {
  // Rule 3: check the finish reason **before** using the content.
  assertUsableStopReason(message, model);

  // Rule 1: never assume the first content block is the answer. On a
  // reasoning-capable model `content[0]` is usually a thinking block, so text
  // parts are selected explicitly and joined rather than indexed by position.
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    }
  }
  const text = parts.join('').trim();

  // Rule 2 / §9.1: never return text not confirmed to be answer content. An
  // empty result fails rather than being written over the user's selection.
  if (text.length === 0) {
    throw new ModelError('bad_request', {
      provider: PROVIDER,
      model,
      detail: `no text content in the response (stop_reason ${String(message.stop_reason)}, ${message.content.length} block(s))`,
    });
  }

  return text;
}

function assertUsableStopReason(
  message: Pick<Anthropic.Message, 'stop_reason' | 'stop_details'>,
  model: string,
): void {
  switch (message.stop_reason) {
    case 'end_turn':
    case 'stop_sequence':
      return;
    case 'refusal':
      throw new ModelError('declined', {
        provider: PROVIDER,
        model,
        detail: `refusal (category ${String(message.stop_details?.category)})`,
      });
    case 'max_tokens':
    case 'model_context_window_exceeded':
      throw new ModelError('truncated', {
        provider: PROVIDER,
        model,
        detail: `stop_reason ${message.stop_reason}`,
      });
    default:
      // `tool_use` and `pause_turn` cannot happen- no tools are declared-
      // and a completed non-streaming message always carries a stop reason.
      // Anything else is our bug, so it fails rather than being trusted.
      throw new ModelError('bad_request', {
        provider: PROVIDER,
        model,
        detail: `unexpected stop_reason ${String(message.stop_reason)}`,
      });
  }
}

/**
 * Maps the SDK's **typed error classes** onto `ModelError.kind` (§9.4). Never
 * matches on message strings, and never puts a raw HTTP body in front of the
 * user- `detail` goes to the output channel only (§9.7).
 *
 * Exported for unit tests.
 */
export function toModelError(error: unknown, context: { model?: string }): unknown {
  const base = { provider: PROVIDER, ...context };

  // Most specific first. `APIUserAbortError` and `APIConnectionError` are both
  // subclasses of `APIError`, so the base class has to be tested last.
  if (error instanceof Anthropic.APIUserAbortError) {
    return new CancelledError();
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ModelError('auth', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ModelError('forbidden', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ModelError('model_not_found', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelError('rate_limit', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new ModelError('bad_request', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ModelError('server', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new TimeoutError(PROVIDER, REQUEST_TIMEOUT_MS);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelError('offline', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new ModelError('server', { ...base, detail: error.message, cause: error });
  }

  // Already one of ours (a stop-reason or empty-text failure raised above), or
  // something genuinely unexpected- either way it passes through unchanged
  // rather than being relabelled as a provider failure.
  return error;
}
