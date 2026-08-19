import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEnhanceMode, type EnhanceMode } from '@prompt-enhancer/prompts';

import { ALL_CRITERIA, type CriterionName } from './criteria.js';

/**
 * Loading and validating `goldens.jsonl`.
 *
 * A malformed golden fails loudly at load rather than silently scoring as a
 * pass- a golden set that quietly shrinks is worse than one that is red.
 */

export interface Golden {
  id: string;
  mode: EnhanceMode;
  /** Why this golden exists. Read it before changing one. */
  note: string;
  rough: string;
  /** Concrete details from the input that must carry verbatim (§5). */
  mustCarry: readonly string[];
  /** Things the input never mentioned, which the output must not supply (§10). */
  mustNotInvent: readonly string[];
  /** Which structural criteria apply. Defaults to all of them. */
  criteria: readonly CriterionName[];
  /** "Scale to the input" (§5)- output length as a multiple of input length. */
  maxLengthRatio: number | undefined;
  /** Subject to the §10 regression rule: must come back materially unchanged. */
  alreadyGood: boolean;
  /** Output must not be one of these verbatim- the injection golden's check. */
  mustNotEqual: readonly string[];
  /** Phrases that must not appear at all. */
  mustNotContain: readonly string[];
  /** ISO code the output should be written in, when the input is not English. */
  expectLanguage: string | undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function fail(id: string, message: string): never {
  throw new Error(`golden "${id}": ${message}`);
}

function asStringArray(value: unknown, id: string, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail(id, `${field} must be an array of strings`);
  }
  return value as string[];
}

function parseGolden(raw: unknown, index: number): Golden {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`goldens.jsonl line ${index + 1}: not an object`);
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record['id'] === 'string' ? record['id'] : `line ${index + 1}`;

  if (typeof record['id'] !== 'string' || record['id'].length === 0) {
    fail(id, 'id is required');
  }
  if (!isEnhanceMode(record['mode'])) {
    fail(id, `mode must be one of the §5 modes, got ${String(record['mode'])}`);
  }
  if (typeof record['note'] !== 'string' || record['note'].length === 0) {
    fail(id, 'note is required- a golden nobody can explain gets deleted, not debugged');
  }

  // Either inline text or a fixture file; the large-paste golden needs the file.
  const inline = record['rough'];
  const fromFile = record['roughFile'];
  let rough: string;
  if (typeof inline === 'string' && inline.length > 0) {
    rough = inline;
  } else if (typeof fromFile === 'string' && fromFile.length > 0) {
    rough = readFileSync(join(root, fromFile), 'utf8');
  } else {
    fail(id, 'needs either rough or roughFile');
  }

  const criteriaRaw = record['criteria'];
  let criteria: readonly CriterionName[];
  if (criteriaRaw === undefined) {
    criteria = ALL_CRITERIA;
  } else {
    const names = asStringArray(criteriaRaw, id, 'criteria');
    for (const name of names) {
      if (!ALL_CRITERIA.includes(name as CriterionName)) {
        fail(id, `unknown criterion "${name}"`);
      }
    }
    criteria = names as CriterionName[];
  }

  const ratio = record['maxLengthRatio'];
  if (ratio !== undefined && typeof ratio !== 'number') {
    fail(id, 'maxLengthRatio must be a number');
  }

  return {
    id: record['id'],
    mode: record['mode'],
    note: record['note'],
    rough,
    mustCarry: asStringArray(record['mustCarry'], id, 'mustCarry'),
    mustNotInvent: asStringArray(record['mustNotInvent'], id, 'mustNotInvent'),
    criteria,
    maxLengthRatio: typeof ratio === 'number' ? ratio : undefined,
    alreadyGood: record['alreadyGood'] === true,
    mustNotEqual: asStringArray(record['mustNotEqual'], id, 'mustNotEqual'),
    mustNotContain: asStringArray(record['mustNotContain'], id, 'mustNotContain'),
    expectLanguage:
      typeof record['expectLanguage'] === 'string' ? record['expectLanguage'] : undefined,
  };
}

export function loadGoldens(path = join(root, 'goldens.jsonl')): Golden[] {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const goldens = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `goldens.jsonl line ${index + 1}: invalid JSON- ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseGolden(parsed, index);
  });

  const ids = new Set<string>();
  for (const golden of goldens) {
    if (ids.has(golden.id)) {
      fail(golden.id, 'duplicate id');
    }
    ids.add(golden.id);
  }

  return goldens;
}
