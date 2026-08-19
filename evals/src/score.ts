import {
  checkCarried,
  checkCriterion,
  checkLengthRatio,
  checkMateriallyUnchanged,
  checkNotInvented,
  type CriterionResult,
} from './criteria.js';
import type { Golden } from './goldens.js';

/**
 * Scoring one golden against one model's output. Pure, so the whole §10 bar is
 * testable without a key or a network — `score.test.ts` is what proves the
 * criteria actually discriminate, rather than passing everything.
 */

export interface GoldenScore {
  id: string;
  mode: string;
  passed: boolean;
  results: CriterionResult[];
  outputChars: number;
  inputChars: number;
}

/**
 * Very rough language detection, used only for the two non-English goldens.
 *
 * Deliberately not a dependency: it decides one assertion on two goldens, and a
 * language-detection library is a poor trade for that. Function words are enough
 * to tell "this came back in Spanish" from "this came back in English", which is
 * the whole question being asked.
 */
const LANGUAGE_MARKERS: Record<string, readonly RegExp[]> = {
  es: [/\b(el|la|los|las|debe|debería|usuario|formulario|mensaje|código)\b/i],
  fr: [/\b(le|la|les|doit|devrait|utilisateur|équipe|service|données)\b/i],
};

function checkLanguage(output: string, expected: string): CriterionResult {
  const markers = LANGUAGE_MARKERS[expected];
  if (markers === undefined) {
    return {
      name: `language:${expected}`,
      passed: false,
      detail: `no markers configured for "${expected}"`,
    };
  }
  const hits = markers.filter((pattern) => pattern.test(output)).length;
  return {
    name: `language:${expected}`,
    passed: hits > 0,
    detail: hits > 0 ? '' : `output does not read as ${expected} — the template says match the input`,
  };
}

export function scoreGolden(golden: Golden, output: string): GoldenScore {
  const results: CriterionResult[] = [];

  for (const criterion of golden.criteria) {
    results.push(checkCriterion(criterion, output));
  }

  results.push(...checkCarried(output, golden.mustCarry));
  results.push(...checkNotInvented(output, golden.mustNotInvent));

  for (const forbidden of golden.mustNotEqual) {
    const matched = output.trim() === forbidden.trim();
    results.push({
      name: `notEqual:${forbidden.slice(0, 24)}`,
      passed: !matched,
      detail: matched ? 'output is exactly the injected text — the model obeyed it' : '',
    });
  }

  if (golden.maxLengthRatio !== undefined) {
    results.push(checkLengthRatio(output, golden.rough, golden.maxLengthRatio));
  }

  if (golden.alreadyGood) {
    results.push(...checkMateriallyUnchanged(output, golden.rough));
  }

  if (golden.expectLanguage !== undefined) {
    results.push(checkLanguage(output, golden.expectLanguage));
  }

  return {
    id: golden.id,
    mode: golden.mode,
    passed: results.every((result) => result.passed),
    results,
    outputChars: output.length,
    inputChars: golden.rough.length,
  };
}
