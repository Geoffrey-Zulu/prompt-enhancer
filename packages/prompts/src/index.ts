/**
 * @prompt-enhancer/prompts
 *
 * The single source of truth for the enhancement prompt (TDD D3).
 *
 * All three consumers — the editor command, the chat participant, and the eval
 * runner — import `renderEnhancePrompt` from here, so the template text exists
 * in exactly one authored file: `templates/enhance.v1.md`.
 *
 * The template is inlined at build time by `scripts/generate.mjs` into
 * `src/generated/template.ts`, which also carries its sha256. Nothing reads
 * from disk at runtime, so this works identically once bundled into a .vsix.
 */

import { TEMPLATE_SOURCE, TEMPLATE_SHA256 } from './generated/template.js';

export { TEMPLATE_SHA256 };

/**
 * Bump when `templates/enhance.*.md` changes behaviour, and re-run the goldens
 * (TDD §5, §10). There is no version negotiation to worry about: the template
 * and the code that uses it ship together in one .vsix.
 */
export const TEMPLATE_VERSION = 'enhance.v1';

/** Closed enum — unknown modes are rejected before any network call. */
export const ENHANCE_MODES = ['code', 'architecture', 'refactor'] as const;
export type EnhanceMode = (typeof ENHANCE_MODES)[number];

export const DEFAULT_MODE: EnhanceMode = 'code';

/** Input caps, enforced client-side and server-side alike (TDD §6). */
export const MAX_ROUGH_TEXT_CHARS = 20_000;
export const MAX_CONTEXT_CHARS = 2_000;

/** The model both paths use (TDD D2). */
export const MODEL_ID = 'gemini-2.5-flash';

export interface EnhanceInput {
  roughText: string;
  context?: string;
  mode: EnhanceMode;
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

export function isEnhanceMode(value: unknown): value is EnhanceMode {
  return typeof value === 'string' && (ENHANCE_MODES as readonly string[]).includes(value);
}

/** Thrown for input that violates the §6 contract. Never carries user text. */
export class PromptInputError extends Error {
  constructor(
    message: string,
    readonly field: 'roughText' | 'context' | 'mode',
  ) {
    super(message);
    this.name = 'PromptInputError';
  }
}

/**
 * Splits the template on `<!-- MARKER -->` lines into a section map. Marker
 * order in the file is irrelevant; a missing section is a build-time bug and
 * throws rather than rendering a half-formed prompt.
 */
function parseSections(source: string): Map<string, string> {
  const sections = new Map<string, string>();
  const pattern = /^<!--\s*([A-Za-z0-9:_.-]+)\s*-->$/gm;

  const markers: Array<{ name: string; start: number; end: number }> = [];
  for (let m = pattern.exec(source); m !== null; m = pattern.exec(source)) {
    markers.push({ name: m[1]!, start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]!;
    const next = markers[i + 1];
    const body = source.slice(marker.end, next ? next.start : source.length);
    sections.set(marker.name, body.trim());
  }

  return sections;
}

function requireSection(sections: Map<string, string>, name: string): string {
  const body = sections.get(name);
  if (body === undefined || body.length === 0) {
    throw new Error(`Prompt template is missing the "${name}" section`);
  }
  return body;
}

const SECTIONS = parseSections(TEMPLATE_SOURCE);

/**
 * Substitutes `{{TOKEN}}` placeholders. Values are inserted literally; any
 * `{{...}}` inside a value is left alone, so rough text that happens to
 * contain braces cannot inject a placeholder.
 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => {
    const value = values[token];
    return value === undefined ? whole : value;
  });
}

/**
 * Renders the enhancement prompt. Pure and deterministic: the same input
 * always produces byte-identical output, so the editor command, the chat
 * participant, and the eval runner cannot disagree about what was sent — which
 * is what makes a golden result meaningful.
 */
export function renderEnhancePrompt(input: EnhanceInput): RenderedPrompt {
  const { roughText, context, mode } = input;

  if (typeof roughText !== 'string' || roughText.trim().length === 0) {
    throw new PromptInputError('Rough text is empty', 'roughText');
  }
  if (roughText.length > MAX_ROUGH_TEXT_CHARS) {
    throw new PromptInputError(
      `Rough text exceeds ${MAX_ROUGH_TEXT_CHARS} characters`,
      'roughText',
    );
  }
  if (context !== undefined && context.length > MAX_CONTEXT_CHARS) {
    throw new PromptInputError(`Context exceeds ${MAX_CONTEXT_CHARS} characters`, 'context');
  }
  if (!isEnhanceMode(mode)) {
    throw new PromptInputError('Unknown enhancement mode', 'mode');
  }

  const system = fill(requireSection(SECTIONS, 'SYSTEM'), {
    MODE: mode,
    MODE_GUIDANCE: requireSection(SECTIONS, `MODE:${mode}`),
  });

  const contextBlock =
    context === undefined || context.trim().length === 0
      ? ''
      : `## Context\n\n${context.trim()}`;

  const user = fill(requireSection(SECTIONS, 'USER'), {
    CONTEXT_BLOCK: contextBlock,
    ROUGH_TEXT: roughText,
  });

  return { system, user: user.replace(/\n{3,}/g, '\n\n') };
}
