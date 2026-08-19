import * as vscode from 'vscode';
import { afterEach, describe, expect, it } from 'vitest';

import { CancelledError, ModelError, TimeoutError } from '../providers/types.js';
import { describeFailure, reportFailure } from './report.js';

/**
 * The §9.4 table, and one property that is easy to lose: reporting a failure must
 * not block the caller.
 */

type Notifier = typeof vscode.window.showInformationMessage;

const realInfo = vscode.window.showInformationMessage;
const realError = vscode.window.showErrorMessage;

afterEach(() => {
  (vscode.window as { showInformationMessage: Notifier }).showInformationMessage = realInfo;
  (vscode.window as { showErrorMessage: Notifier }).showErrorMessage = realError;
});

describe('describeFailure', () => {
  it('names the provider and the model where each is relevant', () => {
    // §9.4: "rate limit reached" without saying whose is a support question
    // waiting to happen, and with three providers in play that matters.
    expect(
      describeFailure(new ModelError('rate_limit', { provider: 'google' }))?.message,
    ).toContain('Google AI');

    expect(
      describeFailure(new ModelError('model_not_found', { provider: 'openai', model: 'gpt-x' }))
        ?.message,
    ).toContain('gpt-x');
  });

  it('treats the no-key state as information, not an error', () => {
    // §7: the user simply has not set up yet.
    const description = describeFailure(new ModelError('no_key'));

    expect(description?.severity).toBe('info');
    expect(description?.action).toBe('Set API Key');
  });

  it('gives a timeout its own message rather than borrowing another kind', () => {
    const description = describeFailure(new TimeoutError('anthropic', 30_000));

    expect(description?.message).toContain('Anthropic');
    expect(description?.message).toContain('30 seconds');
    expect(description?.action).toBe('Retry');
  });

  it('says nothing at all about a cancellation', () => {
    // Not a failure: the user asked for it (§8 Flow A.5).
    expect(describeFailure(new CancelledError())).toBeUndefined();
  });

  it('never puts provider detail in front of the user', () => {
    const description = describeFailure(
      new ModelError('bad_request', {
        provider: 'anthropic',
        detail: 'messages.0.content: expected string, got object',
      }),
    );

    // §9.7: that goes to the output channel, not into a notification.
    expect(description?.message).not.toContain('messages.0.content');
    expect(description?.action).toBe('Open Output');
  });
});

describe('reportFailure', () => {
  it('resolves without waiting for the notification to be dismissed', async () => {
    // A notification carrying a button does not settle until the user clicks it
    // or it times out. Awaiting that here meant the command never finished, so
    // `executeCommand` hung — which is how the integration suite found this, with
    // a 30 s mocha timeout on a headless runner.
    let settle: ((value: undefined) => void) | undefined;
    const never = new Promise<undefined>((resolve) => {
      settle = resolve;
    });
    (vscode.window as { showInformationMessage: unknown }).showInformationMessage = () => never;

    let resolved = false;
    const reporting = reportFailure(new ModelError('no_key')).then(() => {
      resolved = true;
    });

    await reporting;
    expect(resolved, 'reportFailure must not await the user').toBe(true);

    // Tidy up the pending notification so the test does not leak a promise.
    settle?.(undefined);
  });

  it('still resolves when showing the notification fails outright', async () => {
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = () =>
      Promise.reject(new Error('no window'));

    // A broken notification must not turn into an unhandled rejection that takes
    // down whatever was reporting the failure.
    await expect(reportFailure(new ModelError('server', { provider: 'openai' }))).resolves.toBeUndefined();
  });
});
