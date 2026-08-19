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
 * The §9 error surface: a plain-language cause and, where useful, one action.
 * Raw HTTP bodies and stack traces go to the output channel and never to the
 * user (§9.7); the channel redacts keys unconditionally (§9.3).
 *
 * `describeFailure` is the §9.4 table and the only place it exists. The command
 * flows render it as a notification (`reportFailure`); the panel renders it
 * inline (`view/panel.ts`), because a toast behind the panel is a message the
 * user may never see. Two renderers, one table- two copies of a message table
 * drift, and only one of them gets updated.
 *
 * The UI knows `ModelError.kind` and nothing about any provider's error
 * taxonomy; that mapping is each adapter's job.
 */

export type Action = 'Set API Key' | 'Select Model' | 'Retry' | 'Open Output';

export interface FailureContext {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  /** Supplied by callers that can safely be run again. */
  retry?: (() => Promise<void>) | undefined;
}

export interface FailureDescription {
  message: string;
  action: Action | undefined;
  /** `info` for states that are normal rather than broken- see `no_key`. */
  severity: 'error' | 'info';
}

function providerName(provider: ProviderId | undefined): string {
  return provider === undefined ? 'the provider' : PROVIDER_LABELS[provider];
}

function modelName(model: string | undefined): string {
  return model === undefined ? 'the selected model' : `\`${model}\``;
}

/**
 * The §9.4 table. Every message names the provider or the model where one is
 * relevant- with three providers in play, "rate limit reached" without saying
 * whose is a support question waiting to happen.
 */
function describeKind(
  kind: ModelErrorKind,
  context: FailureContext,
): { message: string; action: Action | undefined } {
  const provider = providerName(context.provider);
  const model = modelName(context.model);

  switch (kind) {
    case 'auth':
      return {
        message: `That ${provider} API key was rejected- check it or set a new one.`,
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
        message: `${provider} rate limit reached- wait a moment and retry.`,
        action: 'Retry',
      };
    case 'server':
      return { message: `${provider} is unavailable right now.`, action: 'Retry' };
    case 'offline':
      return { message: `Can't reach ${provider}- check your connection.`, action: undefined };
    case 'truncated':
      return {
        message: `The result from ${model} was truncated- try a smaller selection.`,
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
 * Classifies any failure into what the user should be told, and logs the
 * diagnostic half. Returns `undefined` for a user cancellation: that is not a
 * failure and gets no message at all (§8 Flow A.5).
 */
export function describeFailure(
  error: unknown,
  context: FailureContext = {},
): FailureDescription | undefined {
  if (error instanceof CancelledError) {
    log.info('enhancement cancelled- nothing was written');
    return undefined;
  }

  if (error instanceof ModelError) {
    log.error(`model error (${error.kind})`, error.detail ?? error);
    const merged: FailureContext = {
      provider: error.provider ?? context.provider,
      model: error.model ?? context.model,
    };
    const { message, action } = describeKind(error.kind, merged);
    return {
      message,
      action,
      // The no-key state is normal, not an error (§7)- the user simply has not
      // set up yet, so it gets the same action without the alarm.
      severity: error.kind === 'no_key' ? 'info' : 'error',
    };
  }

  if (error instanceof TimeoutError) {
    log.error(`timed out after ${error.timeoutMs}ms`, error);
    return {
      message: `${PROVIDER_LABELS[error.provider]} did not respond within ${Math.round(error.timeoutMs / 1000)} seconds.`,
      action: 'Retry',
      severity: 'error',
    };
  }

  if (error instanceof PromptInputError) {
    log.error('prompt input rejected', error);
    return { message: `${error.message}.`, action: undefined, severity: 'error' };
  }

  log.error('enhancement failed', error);
  return {
    message: 'Something went wrong. See the Prompt Enhancer output for details.',
    action: 'Open Output',
    severity: 'error',
  };
}

/** Performs the action the user picked. Shared by both renderers. */
export async function runAction(action: Action, context: FailureContext): Promise<void> {
  switch (action) {
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

/**
 * Flow A's renderer: one notification with one action button (§9.2).
 *
 * The caller has already guaranteed the document was not modified (§9.1); this
 * function only ever talks to the user.
 */
export async function reportFailure(
  error: unknown,
  context: FailureContext = {},
): Promise<void> {
  const description = describeFailure(error, context);
  if (description === undefined) {
    return;
  }

  const { message, action, severity } = description;
  const prefixed = `Prompt Enhancer: ${message}`;

  // Branched rather than picking the function into a variable: TypeScript
  // cannot call a union of two overloaded signatures.
  const shown = severity === 'info'
    ? action === undefined
      ? vscode.window.showInformationMessage(prefixed)
      : vscode.window.showInformationMessage(prefixed, action)
    : action === undefined
      ? vscode.window.showErrorMessage(prefixed)
      : vscode.window.showErrorMessage(prefixed, action);

  // **Deliberately not awaited.** A notification carrying a button does not
  // settle until the user clicks it or it times out, so awaiting it here means
  // the command that called us does not finish until someone dismisses a toast-
  // and `executeCommand` hangs for anything driving the extension. The message is
  // already on screen by this point; the action is handled when and if it comes.
  //
  // Compared against `action` rather than cast: the only thing the user can pick
  // is the one button we offered, and the comparison is what proves it.
  void Promise.resolve(shown).then(
    async (chosen) => {
      if (action !== undefined && chosen === action) {
        await runAction(action, context);
      }
    },
    (error: unknown) => {
      log.error('failed to show a notification', error);
    },
  );
}

/**
 * Reports a failure. The command flows pass `reportFailure`; the panel passes a
 * reporter that writes into its own status line instead, so a missing key is
 * reported where the user is looking rather than behind the panel.
 */
export type Reporter = (error: unknown, context?: FailureContext) => Promise<void>;
