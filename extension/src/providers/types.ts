import type { RenderedPrompt } from '@prompt-enhancer/prompts';

/**
 * The one provider abstraction (TDD §6). Callers never branch on provider:
 * every adapter implements this interface fully and normalises its provider's
 * wire format, finish reasons, and error types into the shapes below. A
 * `switch (provider)` anywhere outside `registry.ts` is a design failure.
 *
 * Phase 2 ships one adapter. Phase 3 adds the other two and is expected to
 * change this file — which is why provider specifics live in the adapters.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google';

/**
 * §9.5: 30 s client-side, then abort with a retry action.
 *
 * Lives here rather than in `enhance/` because every adapter needs it for its
 * own HTTP timeout, and three copies of the same number is how they drift. The
 * orchestration's deadline (`enhance/deadline.ts`) is the wall-clock cap; this
 * bounds a single HTTP attempt inside it.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Display names for messages. A lookup table, deliberately not a `switch`. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google AI',
};

/** Narrows a value read from settings, which is a `string` as far as VS Code knows. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, value);
}

/** A model the active key can actually use (D9). Never hardcoded anywhere. */
export interface ModelInfo {
  id: string;
  label: string;
}

export interface ModelClient {
  readonly provider: ProviderId;

  /** Model IDs this key can use (D9). Also serves as key validation (§7). */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  /** Non-streaming: the editor path (D8). Resolves to the finished prompt text. */
  enhance(prompt: RenderedPrompt, model: string, signal?: AbortSignal): Promise<string>;

  /** Streaming: the chat path (D8). Yields text deltas only. */
  enhanceStream(prompt: RenderedPrompt, model: string, signal?: AbortSignal): AsyncIterable<string>;
}

/**
 * The common failure taxonomy (§9.4). Adapters map their SDK's **typed error
 * classes** onto these — never by matching message strings — and the UI maps
 * `kind` to a message and an action. This is the only way three providers stay
 * presentable without the UI knowing three error taxonomies.
 */
export type ModelErrorKind =
  | 'auth'
  | 'forbidden'
  | 'model_not_found'
  | 'rate_limit'
  | 'server'
  | 'offline'
  | 'truncated'
  | 'declined'
  | 'bad_request'
  | 'no_key';

export interface ModelErrorOptions {
  provider?: ProviderId;
  model?: string;
  /** Diagnostics for the output channel. Never shown to the user (§9.7). */
  detail?: string;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly detail: string | undefined;

  constructor(kind: ModelErrorKind, options: ModelErrorOptions = {}) {
    super(`${kind}${options.detail === undefined ? '' : `: ${options.detail}`}`);
    this.name = 'ModelError';
    this.kind = kind;
    this.provider = options.provider;
    this.model = options.model;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * The user cancelled. Not a failure and never surfaced as one: the caller
 * leaves the document exactly as it was and says nothing (§8 Flow A.5).
 */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** The §9.5 client-side deadline elapsed. Distinct from a user cancellation. */
export class TimeoutError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly timeoutMs: number,
  ) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}
