import * as vscode from 'vscode';
import {
  DEFAULT_MODE,
  ENHANCE_MODES,
  isEnhanceMode,
  MAX_ROUGH_TEXT_CHARS,
  renderEnhancePrompt,
  type EnhanceMode,
} from '@prompt-enhancer/prompts';

import { REQUEST_TIMEOUT_MS } from '../enhance/deadline.js';
import { resolveSession, type EnhanceSession } from '../enhance/session.js';
import { log } from '../log.js';
import { CancelledError, PROVIDER_LABELS, TimeoutError } from '../providers/types.js';
import type { Services } from '../services/index.js';
import { createStreamReporter } from './streamReporter.js';

/**
 * Flow B — the `@enhance` chat participant (TDD §8).
 *
 * This is the streaming half of D8: the editor path validates a whole response
 * before writing it into a file, and this path streams plain text into a panel
 * where a partial result is visible but harmless. The two flows share everything
 * up to delivery (`resolveSession`, `renderEnhancePrompt`, the §9.4 table) and
 * differ only in how the result arrives.
 */

export const PARTICIPANT_ID = 'prompt-enhancer.enhance';

/**
 * The slash commands are the mode names, so §5's closed enum is the whole list.
 * Exported for unit tests.
 */
export function modeFrom(command: string | undefined): EnhanceMode {
  return isEnhanceMode(command) ? command : DEFAULT_MODE;
}

export function createChatHandler(services: Services): vscode.ChatRequestHandler {
  return async (request, _context, stream, token): Promise<void> => {
    const roughText = request.prompt.trim();

    if (roughText.length === 0) {
      stream.markdown(
        'Give me a rough note to work with — `@enhance make the login form validate email`.' +
          `\n\nUse \`/${ENHANCE_MODES.join('`, `/')}\` to pick a mode; the default is \`${DEFAULT_MODE}\`.`,
      );
      return;
    }

    // The same §6 cap as the editor path, enforced before any call.
    if (roughText.length > MAX_ROUGH_TEXT_CHARS) {
      stream.markdown(
        `That is ${roughText.length.toLocaleString()} characters, over the ` +
          `${MAX_ROUGH_TEXT_CHARS.toLocaleString()} limit. Send a shorter note.`,
      );
      return;
    }

    const mode = modeFrom(request.command);
    const report = createStreamReporter(stream);

    // §8 Flow B.4: the same resolution as Flow A, but a missing key is reported
    // in the stream rather than as a notification behind the panel.
    const session = await resolveSession(services, report);
    if (session === undefined) {
      return;
    }

    // §8 Flow B.4: name the provider and model, so the user always knows which
    // model answered. Not decoration — with three providers and a model setting,
    // "why is this output different today" is otherwise unanswerable.
    stream.progress(`Enhancing with ${PROVIDER_LABELS[session.provider]} ${session.model}…`);

    try {
      const text = await streamEnhancement(session, roughText, mode, stream, token);

      if (token.isCancellationRequested) {
        // Partial output stays on screen — it is a panel, not the user's file —
        // but no completion buttons are offered for a result that is not one.
        log.info('chat enhancement cancelled mid-stream');
        return;
      }

      offerDelivery(stream, text);
    } catch (error) {
      // The adapters check the terminal finish reason and throw at the end of the
      // stream, so a truncated or declined response lands here *after* its
      // partial text has been rendered. That is why no buttons are offered: the
      // result is visible but must not be presented as finished.
      await report(error, { provider: session.provider, model: session.model });
    }
  };
}

/**
 * Streams the enhancement, yielding markdown as deltas arrive (D8), and returns
 * the full text.
 *
 * The §9.5 deadline applies to **time-to-first-delta**, not to the whole stream.
 * A 30 s cap on the total would kill a long generation halfway through and call
 * it a timeout; what the rule actually protects against is a request that never
 * answers, and the first delta is the proof that it did.
 */
async function streamEnhancement(
  session: EnhanceSession,
  roughText: string,
  mode: EnhanceMode,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<string> {
  const rendered = renderEnhancePrompt({ roughText, mode });

  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());

  let firstDeltaSeen = false;
  let deadlineElapsed = false;
  const deadline = setTimeout(() => {
    if (!firstDeltaSeen) {
      deadlineElapsed = true;
      controller.abort();
    }
  }, REQUEST_TIMEOUT_MS);

  const chunks: string[] = [];
  try {
    for await (const delta of session.client.enhanceStream(
      rendered,
      session.model,
      controller.signal,
    )) {
      firstDeltaSeen = true;
      if (token.isCancellationRequested) {
        break;
      }
      chunks.push(delta);
      stream.markdown(delta);
    }
    return chunks.join('');
  } catch (error) {
    if (deadlineElapsed && error instanceof CancelledError) {
      throw new TimeoutError(session.provider, REQUEST_TIMEOUT_MS);
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    subscription.dispose();
  }
}

/** The two things a user wants next, as buttons rather than instructions. */
function offerDelivery(stream: vscode.ChatResponseStream, text: string): void {
  if (text.trim().length === 0) {
    // An empty stream that still ended cleanly. Nothing to offer, and nothing
    // to pretend about.
    stream.markdown('The model returned nothing usable. Try rephrasing the note.');
    return;
  }

  stream.button({
    command: 'promptEnhancer.insertResult',
    title: 'Insert into editor',
    arguments: [text],
  });
  stream.button({
    command: 'promptEnhancer.copyResult',
    title: 'Copy',
    arguments: [text],
  });
}

/**
 * Follow-ups offer the same note in the other two modes. That is the question a
 * user actually has next — "what would this look like as an architecture
 * prompt?" — and a follow-up re-prompts the participant, which is exactly the
 * mechanism for it.
 */
export function createFollowupProvider(): vscode.ChatFollowupProvider {
  return {
    provideFollowups(_result, context): vscode.ChatFollowup[] {
      const last = context.history.at(-1);
      const previousPrompt =
        last !== undefined && 'prompt' in last ? last.prompt : undefined;

      if (previousPrompt === undefined || previousPrompt.trim().length === 0) {
        return [];
      }

      const usedMode = modeFrom(
        last !== undefined && 'command' in last ? last.command : undefined,
      );

      return ENHANCE_MODES.filter((candidate) => candidate !== usedMode).map((candidate) => ({
        prompt: previousPrompt,
        command: candidate,
        label: `Try /${candidate}`,
      }));
    },
  };
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  services: Services,
): vscode.ChatParticipant {
  // The id must match the `chatParticipants` contribution exactly (§8 Flow B.2).
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    createChatHandler(services),
  );
  participant.followupProvider = createFollowupProvider();
  context.subscriptions.push(participant);
  return participant;
}
