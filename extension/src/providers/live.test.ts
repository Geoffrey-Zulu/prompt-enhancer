import { DEFAULT_MODE, renderEnhancePrompt } from '@prompt-enhancer/prompts';
import { describe, expect, it } from 'vitest';

import { createClient, detectProvider } from './registry.js';
import { PROVIDER_LABELS, type ModelClient, type ProviderId } from './types.js';

/**
 * **Phase 3's acceptance criterion, as a runnable check.**
 *
 * "The same rough text enhances successfully through all three providers, and
 * switching provider needs no re-paste of keys" cannot be asserted against a
 * stubbed `fetch` — the rest of the suite proves what goes on the wire and how a
 * response is read, but not that a provider accepts the request. This does, and
 * it is the only suite here that spends real tokens.
 *
 * **Opt in explicitly:**
 *
 * ```bash
 * PROMPT_ENHANCER_LIVE=1 \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   OPENAI_API_KEY=sk-... \
 *   GOOGLE_API_KEY=AIza... \
 *   pnpm --filter prompt-enhancer test:live
 * ```
 *
 * Every provider whose key is absent is skipped and named in the output, so a
 * partial run reports what it did *not* cover rather than looking complete. The
 * `PROMPT_ENHANCER_LIVE` flag is required on top of the keys: a key sitting in
 * someone's shell for an unrelated reason must not turn `pnpm test` into a bill.
 *
 * Keys come from the environment **here only**. The extension itself never reads
 * `process.env` (§7) — that is the whole point of `SecretService`, and a test is
 * not a reason to weaken it.
 */

const LIVE = process.env['PROMPT_ENHANCER_LIVE'] === '1';

/** The same rough text through every provider — that is what "the same" means. */
const ROUGH_TEXT =
  'the login form should check the email is valid before submitting, currently it posts garbage to /api/session and we get a 500';

/** A distinctive token from the input; the template promises it carries verbatim. */
const MUST_CARRY = '/api/session';

const KEY_ENV: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

interface LiveTarget {
  provider: ProviderId;
  client: ModelClient;
}

function target(provider: ProviderId): LiveTarget | undefined {
  const apiKey = process.env[KEY_ENV[provider]]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return undefined;
  }

  // Route the key the way the extension does, rather than trusting the env var
  // name — this is also a live check of the §6 prefix detection.
  const detected = detectProvider(apiKey);
  if (detected !== provider) {
    throw new Error(
      `${KEY_ENV[provider]} does not look like a ${provider} key (detected: ${String(detected)})`,
    );
  }

  return { provider, client: createClient(provider, apiKey) };
}

const targets = (['anthropic', 'openai', 'google'] as const)
  .map((provider) => target(provider))
  .filter((entry): entry is LiveTarget => entry !== undefined);

const missing = (['anthropic', 'openai', 'google'] as const).filter(
  (provider) => !targets.some((entry) => entry.provider === provider),
);

describe.skipIf(!LIVE)('live acceptance (spends real tokens)', () => {
  it('says which providers this run did not cover', () => {
    if (missing.length > 0) {
      console.warn(
        `\n  NOT COVERED: ${missing.map((provider) => PROVIDER_LABELS[provider]).join(', ')}` +
          `\n  Set ${missing.map((provider) => KEY_ENV[provider]).join(' / ')} to include them.` +
          '\n  Phase 3 acceptance needs all three.\n',
      );
    }
    // Not a failure: a one-provider run is a legitimate thing to do. It just
    // must not be mistaken for the full acceptance run, hence the warning and
    // the explicit record below.
    expect(targets.length).toBeGreaterThan(0);
  });

  describe.each(targets.map((entry) => [entry.provider, entry] as const))(
    '%s',
    (provider, entry) => {
      let model: string | undefined;

      it('lists models the key can use, which is also how a key is validated', async () => {
        const models = await entry.client.listModels();

        expect(models.length).toBeGreaterThan(0);
        for (const candidate of models) {
          expect(candidate.id).toBeTruthy();
          expect(candidate.label).toBeTruthy();
        }

        // D9: the model under test is discovered, never named in this file.
        model = models[0]?.id;
        console.log(
          `  ${PROVIDER_LABELS[provider]}: ${models.length} model(s), using ${String(model)}`,
        );
      });

      it('enhances the rough text into something structurally usable', async () => {
        expect(model, 'listModels must run first').toBeDefined();
        const rendered = renderEnhancePrompt({ roughText: ROUGH_TEXT, mode: DEFAULT_MODE });

        const result = await entry.client.enhance(rendered, model as string);

        // The §9.1 guarantee, live: whatever comes back is usable or the call
        // threw. Nothing empty, nothing truncated, nothing half-written.
        expect(result.trim().length).toBeGreaterThan(ROUGH_TEXT.length);

        // The failure this whole design is arranged around: reasoning reaching
        // the editor path. Any of these in the output means it got there.
        expect(result).not.toMatch(/<\/?thinking>/i);
        expect(result).not.toMatch(/<\/?antml:thinking>/i);
        expect(result).not.toMatch(/^\s*(okay|alright|let me think|the user wants)/i);

        // The system instruction must not be echoed back as content.
        expect(result).not.toContain('senior staff prompt engineer');

        // §10's structural bar, in miniature: the enhanced prompt has to state
        // more than the input did, and carry the input's concrete details.
        expect(result).toContain(MUST_CARRY);
        const concepts = ['role', 'task', 'context', 'constraint', 'output', 'format'];
        const present = concepts.filter((concept) =>
          new RegExp(concept, 'i').test(result),
        );
        expect(
          present.length,
          `expected at least 3 of ${concepts.join('/')}; found ${present.join(', ') || 'none'}`,
        ).toBeGreaterThanOrEqual(3);

        console.log(
          `  ${PROVIDER_LABELS[provider]}/${String(model)}: ${result.length} chars, ` +
            `covers ${present.join(', ')}`,
        );
      });

      it('streams the same work as text deltas only', async () => {
        expect(model, 'listModels must run first').toBeDefined();
        const rendered = renderEnhancePrompt({ roughText: ROUGH_TEXT, mode: DEFAULT_MODE });

        const chunks: string[] = [];
        for await (const chunk of entry.client.enhanceStream(rendered, model as string)) {
          chunks.push(chunk);
        }
        const streamed = chunks.join('');

        // Phase 4 depends on this working on every provider, so it is worth
        // finding out here rather than in the chat panel.
        expect(chunks.length).toBeGreaterThan(0);
        expect(streamed.trim().length).toBeGreaterThan(0);
        expect(streamed).not.toMatch(/<\/?thinking>/i);
      });
    },
  );

  it('records whether the acceptance criterion is actually met', () => {
    const covered = targets.map((entry) => entry.provider);
    const allThree = covered.length === 3;

    console.log(
      `\n  Phase 3 acceptance: ${allThree ? 'MET' : 'NOT MET'} — covered ${
        covered.map((provider) => PROVIDER_LABELS[provider]).join(', ') || 'nothing'
      }.\n`,
    );

    // This assertion is the criterion. It fails on a partial run on purpose:
    // "two of three providers work" is not the bar Phase 3 set, and a green
    // suite that quietly skipped a provider is how an unmet bar gets recorded
    // as met.
    expect(covered.sort()).toEqual(['anthropic', 'google', 'openai']);
  });
});
