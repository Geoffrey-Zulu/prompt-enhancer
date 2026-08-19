import * as vscode from 'vscode';
import { PromptInputError } from '@prompt-enhancer/prompts';

import { log } from '../log.js';
import {
  CancelledError,
  ModelError,
  PROVIDER_LABELS,
  TimeoutError,
  type ModelErrorKind,
  type ProviderId,
} from '../providers/types.js';

/**
 * The §9 error surface. One `showErrorMessage` with a plain-language cause and,
 * where useful, an action button. Raw HTTP bodies and stack traces go to the
 * output channel and never to the user (§9.7); the channel redacts keys
 * unconditionally (§9.3).
 *
 * The UI knows `ModelError.kind` and nothing about any provider's error
 * taxonomy — that mapping is each adapter's job (§9.4).
 */

type Action = 'Set API Key' | 'Select Model' | 'Retry' | 'Open Output';

interface Context {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  /** Supplied by callers that can safely be run again. */
  retry?: (() => Promise<void>) | undefined;
}

function providerName(provider: ProviderId | undefined): string {
  return provider === undefined ? 'the provider' : PROVIDER_LABELS[provider];
}

function modelName(model: string | undefined): string {
  return model === undefined ? 'the selected model' : `\`${model}\``;
}

/**
 * The §9.4 table. Every message names the provider or the model where one is
 * relevant — with three providers in play, "rate limit reached" without saying
 * whose is a support question waiting to happen.
 */
function describe(
  kind: ModelErrorKind,
  context: Context,
): { message: string; action: Action | undefined } {
  const provider = providerName(context.provider);
  const model = modelName(context.model);

  switch (kind) {
    case 'auth':
      return {
        message: `That ${provider} API key was rejected — check it or set a new one.`,
        action: 'Set API Key',
      };
    case 'forbidden':
      return {
        message: `The ${provider} key is valid but not permitted to use ${model}.`,
        action: 'Select Model',
      };
    case 'model_not_found':
      return {
        message: `Model ${model} is not available on your ${provider} key.`,
        action: 'Select Model',
      };
    case 'rate_limit':
      return {
        message: `${provider} rate limit reached — wait a moment and retry.`,
        action: 'Retry',
      };
    case 'server':
      return { message: `${provider} is unavailable right now.`, action: 'Retry' };
    case 'offline':
      return { message: `Can't reach ${provider} — check your connection.`, action: undefined };
    case 'truncated':
      return {
        message: `The result from ${model} was truncated — try a smaller selection.`,
        action: undefined,
      };
    case 'declined':
      return { message: `${model} declined to process this text.`, action: undefined };
    case 'bad_request':
      return { message: `The request to ${provider} was rejected.`, action: 'Open Output' };
    case 'no_key':
      return { message: 'Add an API key to use Prompt Enhancer.', action: 'Set API Key' };
  }
}

/**
 * Reports a failure and, if the user picks the action, performs it. Returns
 * without a message for a user cancellation — that is not a failure (§8 A.5).
 *
 * The caller has already guaranteed the document was not modified (§9.1); this
 * function only ever talks to the user.
 */
export async function reportFailure(error: unknown, context: Context = {}): Promise<void> {
  if (error instanceof CancelledError) {
    log.info('enhancement cancelled — document left unchanged');
    return;
  }

  if (error instanceof ModelError) {
    const merged: Context = {
      provider: error.provider ?? context.provider,
      model: error.model ?? context.model,
      retry: context.retry,
    };
    log.error(`model error (${error.kind})`, error.detail ?? error);
    const { message, action } = describe(error.kind, merged);
    // The no-key state is normal, not an error (§7) — the user simply has not
    // set up yet, so it gets an info notification with the same action.
    await show(message, action, merged, error.kind === 'no_key' ? 'info' : 'error');
    return;
  }

  if (error instanceof TimeoutError) {
    log.error(`timed out after ${error.timeoutMs}ms`, error);
    await show(
      `${PROVIDER_LABELS[error.provider]} did not respond within ${Math.round(error.timeoutMs / 1000)} seconds.`,
      'Retry',
      context,
    );
    return;
  }

  if (error instanceof PromptInputError) {
    log.error('prompt input rejected', error);
    await show(`${error.message}.`, undefined, context);
    return;
  }

  log.error('enhancement failed', error);
  await show('Something went wrong. See the Prompt Enhancer output for details.', 'Open Output', context);
}

async function show(
  message: string,
  action: Action | undefined,
  context: Context,
  severity: 'error' | 'info' = 'error',
): Promise<void> {
  const prefixed = `Prompt Enhancer: ${message}`;
  // Branched rather than picking the function into a variable: TypeScript
  // cannot call a union of two overloaded signatures.
  const chosen = await (severity === 'info'
    ? action === undefined
      ? vscode.window.showInformationMessage(prefixed)
      : vscode.window.showInformationMessage(prefixed, action)
    : action === undefined
      ? vscode.window.showErrorMessage(prefixed)
      : vscode.window.showErrorMessage(prefixed, action));

  if (chosen === undefined) {
    return;
  }

  switch (chosen) {
    case 'Set API Key':
      await vscode.commands.executeCommand('promptEnhancer.setApiKey');
      return;
    case 'Select Model':
      await vscode.commands.executeCommand('promptEnhancer.selectModel');
      return;
    case 'Open Output':
      log.show();
      return;
    case 'Retry':
      await context.retry?.();
      return;
  }
}
