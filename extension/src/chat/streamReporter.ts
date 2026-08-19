import * as vscode from 'vscode';

import {
  describeFailure,
  runAction,
  type FailureContext,
  type Reporter,
} from '../enhance/report.js';

/**
 * Flow B's renderer for the §9.4 table (§8 Flow B.4).
 *
 * A failure in chat is reported **in the chat stream**, not as a notification:
 * the user is looking at the panel, and a toast behind it is a message they may
 * never see. The action becomes a button in the response rather than a button on
 * a toast, backed by the same `runAction` as Flow A.
 */
export function createStreamReporter(stream: vscode.ChatResponseStream): Reporter {
  return async (error: unknown, context: FailureContext = {}): Promise<void> => {
    const description = describeFailure(error, context);
    if (description === undefined) {
      // A cancellation. The user asked for it; saying so adds nothing.
      return;
    }

    stream.markdown(`\n\n${description.message}`);

    // `Retry` becomes a sentence rather than a button. In Flow A retry means
    // re-running a command the extension still holds; here it means re-sending
    // the chat message, which the extension cannot do for the user — and a
    // button that does nothing when clicked is worse than no button.
    if (description.action === 'Retry') {
      stream.markdown(' Send the message again to retry.');
      return;
    }

    if (description.action !== undefined) {
      stream.button({
        command: 'promptEnhancer.runFailureAction',
        title: description.action,
        arguments: [description.action],
      });
    }
  };
}

/**
 * Backs the buttons the reporter above emits. Registered in code and
 * deliberately **not** contributed to `package.json`: it takes an argument, so
 * it would be broken if a user ran it from the command palette.
 */
export async function runFailureAction(action?: unknown): Promise<void> {
  // `Retry` is absent on purpose — see the reporter above.
  if (action === 'Set API Key' || action === 'Select Model' || action === 'Open Output') {
    await runAction(action, {});
  }
}
