import OpenAI from 'openai';
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
 * The OpenAI adapter (TDD §6). Built on the Responses API rather than Chat
 * Completions: its `max_output_tokens` covers reasoning **plus** the answer,
 * which is exactly the budget §6 asks for, and `instructions` is a first-class
 * system slot rather than a message with a special role.
 *
 * **No model ID appears here** (D9).
 */

const PROVIDER = 'openai' as const;

/**
 * Larger than the Anthropic adapter's budget on purpose. This adapter does not
 * cap reasoning effort (see the note in `enhance`), so a reasoning model may
 * spend a good deal of this cap before it writes anything — and hitting the cap
 * is a `truncated` failure, not a shorter answer.
 */
const MAX_OUTPUT_TOKENS = 32_000;

/**
 * `GET /v1/models` returns every model on the key — embeddings, speech, image,
 * moderation — with **no capability information** to filter on (the `Model`
 * object is `id`, `created`, `owned_by`). Listing all of it puts image and audio
 * models in a prompt-enhancer's model picker.
 *
 * So this excludes non-text *modality families*, which is not a D9 violation:
 * it names no model, supplies no default, and — being an exclusion rather than
 * an allow-list — a newly released text model appears without a code change
 * instead of being silently hidden. That direction is the whole point.
 */
const NON_TEXT_MODEL_MARKERS: readonly string[] = [
  'embedding',
  'moderation',
  'whisper',
  'tts',
  'audio',
  'transcribe',
  'realtime',
  'dall-e',
  'image',
  'sora',
  'clip',
  'davinci', // legacy base-completion models, not chat
  'babbage',
];

function isTextGenerationModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_TEXT_MODEL_MARKERS.some((marker) => lower.includes(marker));
}

export class OpenAIClient implements ModelClient {
  readonly provider = PROVIDER;

  private readonly sdk: OpenAI;

  constructor(apiKey: string) {
    this.sdk = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const page = await this.sdk.models.list({ signal });
      return page.data
        .filter((model) => isTextGenerationModel(model.id))
        // Newest first, so the quick-pick is useful without naming a model.
        .sort((left, right) => right.created - left.created)
        .map((model) => ({ id: model.id, label: model.id }));
    } catch (error) {
      throw toModelError(error, {});
    }
  }

  async enhance(prompt: RenderedPrompt, model: string, signal?: AbortSignal): Promise<string> {
    let response: OpenAI.Responses.Response;
    try {
      response = await this.sdk.responses.create(
        {
          model,
          // The provider's system slot, never concatenated into the user text (§6).
          instructions: prompt.system,
          input: prompt.user,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          // Deliberately no `reasoning: {effort}`. The model list this adapter
          // offers includes non-reasoning models, and sending `reasoning` to one
          // of those is a 400 — so the user's model choice would decide whether
          // the extension worked. Omitting it leaves each model on its own
          // default, which for a reasoning model means reasoning stays on: the
          // safe setting §6 asks for.
          //
          // No temperature / top_p either (§6).
          //
          // The default is `store: true`, which would leave the user's selected
          // text sitting in their OpenAI account. §13 promises the text goes to
          // the provider and nowhere else; retention is not part of that deal.
          store: false,
        },
        { signal },
      );
    } catch (error) {
      throw toModelError(error, { model });
    }

    return readAnswerText(response, model);
  }

  async *enhanceStream(
    prompt: RenderedPrompt,
    model: string,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    const stream = this.sdk.responses.stream(
      {
        model,
        instructions: prompt.system,
        input: prompt.user,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      },
      { signal },
    );

    try {
      for await (const event of stream) {
        // Text deltas only. Reasoning summary events, tool events, and every
        // other event type are filtered out here (§6).
        if (event.type === 'response.output_text.delta') {
          yield event.delta;
        }
      }
      // The terminal status is checked before the consumer may treat the result
      // as complete (§6).
      assertUsableStatus(await stream.finalResponse(), model);
    } catch (error) {
      throw toModelError(error, { model });
    }
  }
}

/**
 * The §6 "reading the response" contract for the Responses API. Exported for
 * unit tests.
 */
export function readAnswerText(response: OpenAI.Responses.Response, model: string): string {
  // Rule 3: check the finish reason **before** using the content.
  assertUsableStatus(response, model);

  // Rule 1: never assume the first output item is the answer. On a reasoning
  // model `output[0]` is a `reasoning` item, so message items are selected
  // explicitly and their text parts joined.
  const parts: string[] = [];
  const refusals: string[] = [];
  for (const item of response.output) {
    if (item.type !== 'message') {
      continue;
    }
    for (const content of item.content) {
      if (content.type === 'output_text') {
        parts.push(content.text);
      } else if (content.type === 'refusal') {
        refusals.push(content.refusal);
      }
    }
  }
  const text = parts.join('').trim();

  // A refusal is a failure, never something written over the selection.
  if (text.length === 0 && refusals.length > 0) {
    throw new ModelError('declined', {
      provider: PROVIDER,
      model,
      detail: `refusal content part (${refusals.length})`,
    });
  }

  // Rule 2 / §9.1: never return text not confirmed to be answer content.
  if (text.length === 0) {
    throw new ModelError('bad_request', {
      provider: PROVIDER,
      model,
      detail: `no output_text in the response (status ${String(response.status)}, ${response.output.length} item(s))`,
    });
  }

  return text;
}

function assertUsableStatus(
  response: Pick<OpenAI.Responses.Response, 'status' | 'incomplete_details' | 'error'>,
  model: string,
): void {
  switch (response.status) {
    case 'completed':
    case undefined:
      return;
    case 'incomplete':
      if (response.incomplete_details?.reason === 'content_filter') {
        throw new ModelError('declined', {
          provider: PROVIDER,
          model,
          detail: 'incomplete: content_filter',
        });
      }
      throw new ModelError('truncated', {
        provider: PROVIDER,
        model,
        detail: `incomplete: ${String(response.incomplete_details?.reason)}`,
      });
    case 'failed':
      throw new ModelError('bad_request', {
        provider: PROVIDER,
        model,
        detail: `failed: ${response.error?.code ?? 'unknown'} ${response.error?.message ?? ''}`.trim(),
      });
    default:
      // `in_progress` / `queued` / `cancelled` cannot happen on a synchronous,
      // non-background request. Anything else is our bug, so it fails rather
      // than being trusted.
      throw new ModelError('bad_request', {
        provider: PROVIDER,
        model,
        detail: `unexpected status ${String(response.status)}`,
      });
  }
}

/**
 * Maps the SDK's **typed error classes** onto `ModelError.kind` (§9.4). The
 * OpenAI SDK's error hierarchy mirrors Anthropic's, so this reads almost
 * identically — which is the abstraction working, not duplication to remove:
 * each adapter owns its provider's taxonomy.
 *
 * Exported for unit tests.
 */
export function toModelError(error: unknown, context: { model?: string }): unknown {
  const base = { provider: PROVIDER, ...context };

  // Most specific first; the base `APIError` has to be tested last.
  if (error instanceof OpenAI.APIUserAbortError) {
    return new CancelledError();
  }
  if (error instanceof OpenAI.AuthenticationError) {
    return new ModelError('auth', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return new ModelError('forbidden', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.NotFoundError) {
    return new ModelError('model_not_found', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.RateLimitError) {
    return new ModelError('rate_limit', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.BadRequestError) {
    return new ModelError('bad_request', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.InternalServerError) {
    return new ModelError('server', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new TimeoutError(PROVIDER, REQUEST_TIMEOUT_MS);
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ModelError('offline', { ...base, detail: error.message, cause: error });
  }
  if (error instanceof OpenAI.APIError) {
    return new ModelError('server', { ...base, detail: error.message, cause: error });
  }

  // Already one of ours, or a genuine surprise — passed through unchanged
  // rather than relabelled as a provider failure.
  return error;
}
