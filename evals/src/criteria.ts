/**
 * The §10 quality bar, as checks.
 *
 * Every criterion asserts a **structural** property, never exact text — the
 * point of a golden is that the prompt template can be reworded without the
 * suite going red, while a template that stops producing a usable prompt shape
 * fails immediately.
 *
 * These are deliberately loose. A criterion that is too strict fails on wording
 * and gets disabled; a criterion that is too loose passes anything and gets
 * ignored. The bar aimed at here is "would a coding assistant know what to do
 * without asking a clarifying question", which is what §1 says the extension is
 * for.
 */

export type CriterionName =
  | 'role'
  | 'task'
  | 'constraints'
  | 'outputFormat'
  | 'notAnAnswer'
  | 'noReasoningLeak';

export const ALL_CRITERIA: readonly CriterionName[] = [
  'role',
  'task',
  'constraints',
  'outputFormat',
  'notAnAnswer',
  'noReasoningLeak',
];

export interface CriterionResult {
  name: string;
  passed: boolean;
  /** Why it failed, in a form that points at the fix. Empty when it passed. */
  detail: string;
}

const PATTERNS: Record<CriterionName, RegExp> = {
  // "You are a…", "## Role", "Act as…" — any of the ways a prompt sets a stance.
  role: /(^|\n)\s*(#{1,4}\s*|\**)\s*role\b|you are (a|an|the)\b|act as (a|an)\b/i,
  task: /(^|\n)\s*(#{1,4}\s*|\**)\s*(task|objective|goal)\b|your task is|you (must|should|need to) (write|change|produce|implement|design|refactor|add|fix)/i,
  constraints: /(^|\n)\s*(#{1,4}\s*|\**)\s*(constraints?|requirements?|rules?|boundaries)\b|must not\b|do not\b|don't\b|without (changing|breaking)/i,
  outputFormat: /(^|\n)\s*(#{1,4}\s*|\**)\s*(output|output format|deliverable|response format|format)\b|respond with\b|return (a|an|the|only)\b|as a (diff|patch|list|table)\b|provide (a|an|the)\b/i,
  // The model must produce a prompt, not answer the note (§5 hard rules).
  notAnAnswer: /^/,
  // Reasoning markup must never reach the output (§6 reading rule 2).
  noReasoningLeak: /^/,
};

/** Markers that mean internal reasoning reached the visible response. */
const REASONING_MARKERS: readonly RegExp[] = [
  /<\/?thinking>/i,
  /<\/?antml:thinking>/i,
  /^\s*(okay|alright|let me think|let's think|first,? I(’|')?ll|the user wants)/i,
  /\bas an AI\b/i,
];

/**
 * Signals the model answered the note instead of rewriting it as a prompt. A
 * code fence full of an implementation is the giveaway: the template asks for a
 * prompt *requesting* the change, not the change.
 */
function looksLikeAnAnswer(output: string): string {
  const fencedBlocks = output.match(/```[\s\S]*?```/g) ?? [];
  const substantialCode = fencedBlocks.filter((block) => block.split('\n').length > 8);
  if (substantialCode.length > 0) {
    return `contains a ${substantialCode[0]?.split('\n').length ?? 0}-line code block, which reads as an implementation rather than a prompt asking for one`;
  }
  return '';
}

export function checkCriterion(name: CriterionName, output: string): CriterionResult {
  if (name === 'noReasoningLeak') {
    const hit = REASONING_MARKERS.find((pattern) => pattern.test(output));
    return {
      name,
      passed: hit === undefined,
      detail: hit === undefined ? '' : `matched reasoning marker ${String(hit)}`,
    };
  }

  if (name === 'notAnAnswer') {
    const detail = looksLikeAnAnswer(output);
    return { name, passed: detail === '', detail };
  }

  const passed = PATTERNS[name].test(output);
  return { name, passed, detail: passed ? '' : `no text matching ${name}` };
}

/** Concrete details from the input that must survive verbatim (§5 hard rules). */
export function checkCarried(output: string, mustCarry: readonly string[]): CriterionResult[] {
  return mustCarry.map((token) => ({
    name: `carries:${token}`,
    passed: output.includes(token),
    detail: output.includes(token) ? '' : `"${token}" from the input is missing`,
  }));
}

/**
 * The §10 "invents nothing" rule, made checkable: per golden, a list of things
 * the input never mentioned. A template that starts supplying a test runner or a
 * framework the user did not name is the failure this catches.
 */
export function checkNotInvented(
  output: string,
  mustNotInvent: readonly string[],
): CriterionResult[] {
  return mustNotInvent.map((token) => {
    const invented = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
      output,
    );
    return {
      name: `invents:${token}`,
      passed: !invented,
      detail: invented ? `"${token}" appears but the input never mentioned it` : '',
    };
  });
}

/**
 * "Scale to the input" (§5): a one-line note must not become five sections of
 * scaffolding. Expressed as a ratio because an absolute cap would depend on the
 * length of the input.
 */
export function checkLengthRatio(
  output: string,
  input: string,
  maxRatio: number,
): CriterionResult {
  const ratio = output.length / Math.max(input.length, 1);
  const passed = ratio <= maxRatio;
  return {
    name: `lengthRatio<=${maxRatio}`,
    passed,
    detail: passed ? '' : `output is ${ratio.toFixed(1)}x the input, over the ${maxRatio}x bound`,
  };
}

/**
 * **The regression rule (§10).** An input that is already a good prompt must come
 * back materially unchanged. An enhancer that inflates good prompts is worse than
 * no enhancer, and this is the check that says so.
 *
 * Measured two ways, because either alone is gameable: the output must not have
 * grown much, and the input's own substantive lines must still be present.
 */
export function checkMateriallyUnchanged(output: string, input: string): CriterionResult[] {
  const growth = output.length / Math.max(input.length, 1);
  const grewLittle = growth <= 1.5;

  const inputLines = input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 12);
  const surviving = inputLines.filter((line) => output.includes(line));
  const kept = inputLines.length === 0 ? 1 : surviving.length / inputLines.length;
  const keptMost = kept >= 0.6;

  return [
    {
      name: 'regression:noInflation',
      passed: grewLittle,
      detail: grewLittle ? '' : `already-good prompt grew ${growth.toFixed(1)}x`,
    },
    {
      name: 'regression:keptContent',
      passed: keptMost,
      detail: keptMost
        ? ''
        : `only ${surviving.length}/${inputLines.length} of the original's lines survived`,
    },
  ];
}
