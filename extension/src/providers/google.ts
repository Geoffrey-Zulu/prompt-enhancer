import { ApiError, GoogleGenAI, type GenerateContentResponse } from '@google/genai';
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
 * The Google AI adapter (TDD §6).
 *
 * Two things here differ from the other two adapters, and both are the adapter
 * absorbing a provider difference rather than leaking it (§6):
 *
 * - **Reasoning is returned as a marked-up part, not a separate block.** A
 *   Gemini thinking part is a normal text part with `thought: true`. Filtering
 *   on `part.thought` is therefore the same guarantee the Anthropic adapter
 *   makes by filtering block types, and forgetting it would put reasoning in the
 *   user's file (§6 reading rule 2).
 * - **There is one error class, not a hierarchy.** `ApiError` carries a numeric
 *   `status`, so the §9.4 mapping switches on that. That is still structured
 *   data off a typed error, not a message-string match — the thing §9.4 forbids.
 *
 * **No model ID appears here** (D9).
 */

const PROVIDER = 'google' as const;

/**
 * Gemini's thinking tokens count against `maxOutputTokens`, and this adapter
 * does not cap thinking (see `enhance`), so the budget is sized for both.
 */
const MAX_OUTPUT_TOKENS = 32_000;

/** One page of models; well above the catalogue size. */
const MODEL_PAGE_SIZE = 100;

/** Finish reasons that mean the model declined, rather than failed or stopped. */
const DECLINED_FINISH_REASONS: readonly string[] = [
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'LANGUAGE',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
];

export class GoogleClient implements ModelClient {
  readonly provider = PROVIDER;

  private readonly sdk: GoogleGenAI;

  constructor(apiKey: string) {
    this.sdk = new GoogleGenAI({ apiKey });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    try {
      const pager = await this.sdk.models.list({
        config: {
          queryBase: true,
          pageSize: MODEL_PAGE_SIZE,
          ...(signal === undefined ? {} : { abortSignal: signal }),
          httpOptions: { timeout: REQUEST_TIMEOUT_MS },
        },
      });

      return pager.page
        // Keep a model unless it is known *not* to generate content. An
        // exclusion rather than an allow-list, so a model that reports no
        // actions at all still shows up instead of vanishing (see the same
        // reasoning in `openai.ts`).
        .filter((model) => model.supportedActions?.includes('generateContent') !== false)
        .map((model) => {
          const id = stripModelPrefix(model.name ?? '');
          return { id, label: model.displayName ?? id };
        })
        .filter((model) => model.id.length > 0);
    } catch (error) {
      throw toModelError(error, {});
    }
  }

  async enhance(prompt: RenderedPrompt, model: string, signal?: AbortSignal): Promise<string> {
    let response: GenerateContentResponse;
    try {
      response = await this.sdk.models.generateContent({
        model,
        contents: prompt.user,
        config: {
          // Gemini's system slot, never concatenated into the user text (§6).
          systemInstruction: prompt.system,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          ...(signal === undefined ? {} : { abortSignal: signal }),
          // No temperature / topP / topK (§6).
          //
          // No `thinkingConfig` either: the model's own default is the safe
          // setting §6 asks for, and pinning a thinking budget here would be the
          // same mistake as pinning a model ID — the right number differs per
          // model and changes with each release. `includeThoughts` defaults to
          // false, so thoughts are not returned; the reader filters them anyway.
          //
          // Caching is implicit on the current Gemini models and needs no
          // parameter, so there is nothing to attach a breakpoint to.
        },
      });
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
    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.sdk.models.generateContentStream({
        model,
        contents: prompt.user,
        config: {
          systemInstruction: prompt.system,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          httpOptions: { timeout: REQUEST_TIMEOUT_MS },
          ...(signal === undefined ? {} : { abortSignal: signal }),
        },
      });
    } catch (error) {
      throw toModelError(error, { model });
    }

    try {
      let last: GenerateContentResponse | undefined;
      for await (const chunk of stream) {
        last = chunk;
        const text = answerParts(chunk).join('');
        if (text.length > 0) {
          yield text;
        }
      }
      // The terminal finish reason is checked before the consumer may treat the
      // result as complete (§6).
      if (last !== undefined) {
        assertUsableFinish(last, model);
      }
    } catch (error) {
      throw toModelError(error, { model });
    }
  }
}

/** `models/gemini-x` and `gemini-x` are both accepted; store the bare id. */
function stripModelPrefix(name: string): string {
  return name.startsWith('models/') ? name.slice('models/'.length) : name;
}

/**
 * The answer text parts of the first candidate — **thinking parts excluded**.
 *
 * This is the §6 reading rule that matters most on this provider: a thought is
 * a text part with `thought: true`, so a reader that just concatenates every
 * `part.text` puts the model's reasoning into the user's file. Exported for
 * unit tests, which is where that guarantee is actually pinned down.
 */
export function answerParts(response: GenerateContentResponse): string[] {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string' && part.thought !== true) {
      texts.push(part.text);
    }
  }
  return texts;
}

/**
 * The §6 "reading the response" contract. Exported for unit tests.
 */
export function readAnswerText(response: GenerateContentResponse, model: string): string {
  // Rule 3: check the finish reason **before** using the content — including
  // the prompt-level block, which comes back with no candidate at all.
  assertUsableFinish(response, model);

  // Rule 1: select the answer parts explicitly rather than taking everything.
  const text = answerParts(response).join('').trim();

  // Rule 2 / §9.1: an empty result fails rather than being written over the
  // user's selection. A response whose only parts were thoughts lands here.
  if (text.length === 0) {
    throw new ModelError('bad_request', {
      provider: PROVIDER,
      model,
      detail: `no answer text in the response (finishReason ${String(response.candidates?.[0]?.finishReason)})`,
    });
  }

  return text;
}

function assertUsableFinish(response: GenerateContentResponse, model: string): void {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason !== undefined) {
    throw new ModelError('declined', {
      provider: PROVIDER,
      model,
      detail: `prompt blocked: ${String(blockReason)}`,
    });
  }

  const finishReason = response.candidates?.[0]?.finishReason;

  // A streamed chunk mid-flight has no finish reason yet; that is not a failure.
  if (finishReason === undefined || finishReason === 'STOP') {
    return;
  }
  if (finishReason === 'MAX_TOKENS') {
    throw new ModelError('truncated', {
      provider: PROVIDER,
      model,
      detail: 'finishReason MAX_TOKENS',
    });
  }
  if (DECLINED_FINISH_REASONS.includes(finishReason)) {
    throw new ModelError('declined', {
      provider: PROVIDER,
      model,
      detail: `finishReason ${finishReason}`,
    });
  }
  throw new ModelError('bad_request', {
    provider: PROVIDER,
    model,
    detail: `unexpected finishReason ${finishReason}`,
  });
}

/**
 * Maps failures onto `ModelError.kind` (§9.4).
 *
 * Unlike the other two SDKs there is no class per status — `ApiError` carries a
 * numeric `status` — so the switch is on that. Still structured data off a typed
 * error rather than a message-string match.
 *
 * Exported for unit tests.
 */
export function toModelError(error: unknown, context: { model?: string }): unknown {
  const base = { provider: PROVIDER, ...context };

  // An aborted `fetch` rejects with a DOMException named `AbortError`. Matching
  // the name is matching a web-platform contract, not parsing a message.
  if (error instanceof Error && error.name === 'AbortError') {
    return new CancelledError();
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new TimeoutError(PROVIDER, REQUEST_TIMEOUT_MS);
  }

  if (error instanceof ApiError) {
    const detail = { ...base, detail: `${error.status}: ${error.message}`, cause: error };
    switch (error.status) {
      case 400:
        // Gemini answers an invalid API key with 400 INVALID_ARGUMENT rather
        // than 401, so a bad key would otherwise surface as "our bug" with no
        // Set API Key action. Checked by class and status, not message text.
        return isApiKeyRejection(error)
          ? new ModelError('auth', detail)
          : new ModelError('bad_request', detail);
      case 401:
        return new ModelError('auth', detail);
      case 403:
        return new ModelError('forbidden', detail);
      case 404:
        return new ModelError('model_not_found', detail);
      case 429:
        return new ModelError('rate_limit', detail);
      default:
        return error.status >= 500
          ? new ModelError('server', detail)
          : new ModelError('bad_request', detail);
    }
  }

  // A transport failure never reaches `ApiError` — it comes out of `fetch`.
  if (error instanceof TypeError) {
    return new ModelError('offline', { ...base, detail: error.message, cause: error });
  }

  return error;
}

/**
 * Whether a 400 is really a rejected key.
 *
 * This is the one place any adapter looks at an error's text, and it is a
 * deliberate, narrow exception to §9.4's rule: Gemini returns
 * `400 INVALID_ARGUMENT` with reason `API_KEY_INVALID` for a bad key, and there
 * is no status or class that separates it from a malformed request. The
 * alternative is telling a user with a typo'd key that they hit an internal bug,
 * with no action button. The structured `reason` is preferred and the message is
 * only a fallback.
 */
function isApiKeyRejection(error: ApiError): boolean {
  const details: unknown = (error as unknown as { details?: unknown }).details;
  const serialised = typeof details === 'string' ? details : JSON.stringify(details ?? '');
  return /API_KEY_INVALID|API key not valid/i.test(`${serialised} ${error.message}`);
}
