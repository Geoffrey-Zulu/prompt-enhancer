import {
  CancelledError,
  REQUEST_TIMEOUT_MS,
  TimeoutError,
  type ProviderId,
} from '../providers/types.js';

export { REQUEST_TIMEOUT_MS };

/**
 * Runs one provider call under the §9.5 deadline, with the user's cancellation
 * folded into the same `AbortSignal` so cancellation is real rather than
 * cosmetic (§8 Flow A.5).
 *
 * The two ways an abort can happen have to stay distinguishable: a user
 * cancellation is silent and leaves the document untouched, while the deadline
 * is a failure that deserves a message and a Retry. Both reach the adapter as
 * the same aborted signal, so the flag below is what tells them apart.
 */
export async function withDeadline<T>(
  provider: ProviderId,
  cancel: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let deadlineElapsed = false;

  const timer = setTimeout(() => {
    deadlineElapsed = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  const forwardCancel = (): void => controller.abort();
  if (cancel !== undefined) {
    if (cancel.aborted) {
      controller.abort();
    } else {
      cancel.addEventListener('abort', forwardCancel, { once: true });
    }
  }

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (deadlineElapsed && error instanceof CancelledError) {
      throw new TimeoutError(provider, REQUEST_TIMEOUT_MS);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    cancel?.removeEventListener('abort', forwardCancel);
  }
}
