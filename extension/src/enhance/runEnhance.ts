import {
  renderEnhancePrompt,
  TEMPLATE_VERSION,
  type EnhanceInput,
} from '@prompt-enhancer/prompts';

import { log } from '../log.js';
import { ModelError } from '../providers/types.js';
import { withDeadline } from './deadline.js';
import type { EnhanceSession } from './session.js';

/**
 * The shared orchestration: validate → render → call (TDD §8). Only delivery
 * differs between the editor path and the chat path, so only delivery lives in
 * the callers.
 *
 * This function never touches a document. That is what makes the §9.1
 * guarantee cheap to keep: a caller cannot apply a result it has not received.
 */
export async function runEnhance(
  session: EnhanceSession,
  input: EnhanceInput,
  cancel?: AbortSignal,
): Promise<string> {
  // Caps and mode are enforced here, before any network call (§6). A rejected
  // input throws `PromptInputError` and nothing is sent.
  const rendered = renderEnhancePrompt(input);

  log.info(
    `enhancing ${input.roughText.length} chars via ${session.provider}/${session.model} ` +
      `(${TEMPLATE_VERSION}, mode ${input.mode})`,
  );

  const text = await withDeadline(session.provider, cancel, (signal) =>
    session.client.enhance(rendered, session.model, signal),
  );

  // The adapter already refuses to return unconfirmed or empty content (§6).
  // This second check is here because the cost of being wrong is writing
  // rubbish over the user's selection (§9.1), and it costs one comparison.
  if (text.trim().length === 0) {
    throw new ModelError('bad_request', {
      provider: session.provider,
      model: session.model,
      detail: 'adapter returned empty text',
    });
  }

  log.info(`enhanced to ${text.length} chars`);
  return text;
}
