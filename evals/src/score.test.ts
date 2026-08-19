import { describe, expect, it } from 'vitest';

import { loadGoldens, type Golden } from './goldens.js';
import { scoreGolden } from './score.js';

/**
 * These tests exist because a scoring suite that passes everything is worse than
 * no scoring suite: it turns "the goldens are green" into a statement about
 * nothing. So each check below feeds the scorer an output that is wrong in
 * exactly one way and asserts the corresponding criterion — and only that one —
 * goes red.
 */

const goldens = loadGoldens();

function golden(id: string): Golden {
  const found = goldens.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no golden "${id}" — a test is out of date with goldens.jsonl`);
  }
  return found;
}

/** What a good enhancement of `code-null-check` looks like. */
const GOOD_OUTPUT = `## Role
You are a senior Java engineer working in an existing codebase.

## Task
Fix the NullPointerException thrown by UserRepo.findById(id) at line 42 when the
supplied id is not present in the table.

## Context
The method currently assumes the lookup always returns a row. The exception
surfaces at line 42.

## Constraints
- Do not change the method signature.
- Callers must not have to handle a new checked exception.
- Do not introduce a new dependency.

## Output format
The corrected method body, plus one sentence explaining the approach.

## Unspecified
- Whether an absent id should return an empty value or raise a domain error.
`;

function failedNames(output: string, id: string): string[] {
  return scoreGolden(golden(id), output)
    .results.filter((result) => !result.passed)
    .map((result) => result.name);
}

describe('the golden set itself', () => {
  it('loads, and covers every §10 adversarial case', () => {
    expect(goldens.length).toBeGreaterThanOrEqual(15);

    const modes = new Set(goldens.map((entry) => entry.mode));
    expect([...modes].sort()).toEqual(['architecture', 'code', 'refactor']);

    // §10 names these explicitly. A golden set missing one of them is not the
    // bar the design asked for.
    expect(goldens.some((entry) => entry.rough.trim().split(/\s+/).length === 1)).toBe(true);
    expect(goldens.some((entry) => entry.rough.length > 15_000)).toBe(true);
    expect(goldens.filter((entry) => entry.alreadyGood).length).toBeGreaterThanOrEqual(3);
    expect(goldens.some((entry) => entry.expectLanguage !== undefined)).toBe(true);
    expect(goldens.some((entry) => entry.rough.includes('IGNORE ALL PREVIOUS'))).toBe(true);
  });

  it('keeps every input inside the §6 cap, or the runner would never send it', () => {
    // A golden the extension would reject before calling out is not testing the
    // model — it is testing the cap, which has its own unit test.
    for (const entry of goldens) {
      expect(entry.rough.length, entry.id).toBeLessThanOrEqual(20_000);
    }
  });

  it('has the regression rule on an already-good prompt in all three modes', () => {
    const modes = goldens.filter((entry) => entry.alreadyGood).map((entry) => entry.mode);
    expect([...modes].sort()).toEqual(['architecture', 'code', 'refactor']);
  });
});

describe('scoreGolden', () => {
  it('passes a well-formed enhancement', () => {
    const score = scoreGolden(golden('code-null-check'), GOOD_OUTPUT);

    expect(score.passed, score.results.filter((r) => !r.passed).map((r) => r.name).join(', ')).toBe(
      true,
    );
  });

  it('fails when the prompt states no role', () => {
    const noRole = GOOD_OUTPUT.replace(
      '## Role\nYou are a senior Java engineer working in an existing codebase.',
      '',
    );

    expect(failedNames(noRole, 'code-null-check')).toEqual(['role']);
  });

  it('fails when constraints are dropped', () => {
    const noConstraints = GOOD_OUTPUT.replace(
      /## Constraints[\s\S]*?## Output format/,
      '## Output format',
    );

    expect(failedNames(noConstraints, 'code-null-check')).toEqual(['constraints']);
  });

  it('fails when the input\'s concrete details are not carried through', () => {
    // §5: identifiers, paths, error strings and line numbers carry verbatim.
    const paraphrased = GOOD_OUTPUT.replaceAll('UserRepo.findById', 'the repository lookup');

    expect(failedNames(paraphrased, 'code-null-check')).toEqual(['carries:UserRepo.findById']);
  });

  it('fails when the model invents a requirement the input never mentioned', () => {
    // The §10 "invents nothing" rule. Nobody said anything about Mockito.
    const invented = GOOD_OUTPUT.replace(
      '- Do not introduce a new dependency.',
      '- Add a Mockito-based unit test covering the null case.',
    );

    expect(failedNames(invented, 'code-null-check')).toEqual(['invents:Mockito']);
  });

  it('fails when reasoning leaks into the output', () => {
    // The failure this whole design is arranged around (§6 reading rule 2): on
    // the editor path this text goes straight into the user's file.
    for (const leak of [
      `<thinking>the user wants a null check</thinking>\n${GOOD_OUTPUT}`,
      `Okay, so the user wants me to fix a null check.\n\n${GOOD_OUTPUT}`,
    ]) {
      expect(failedNames(leak, 'code-null-check')).toEqual(['noReasoningLeak']);
    }
  });

  it('fails when the model answers the note instead of rewriting it as a prompt', () => {
    // §5: "if the input says fix this null check, you produce a prompt asking
    // for the fix; you do not write the fix."
    const answered = `${GOOD_OUTPUT}\n\`\`\`java\n${Array.from({ length: 12 }, (_, i) => `  line${i}();`).join('\n')}\n\`\`\`\n`;

    expect(failedNames(answered, 'code-null-check')).toEqual(['notAnAnswer']);
  });

  it('enforces the regression rule on an already-good prompt', () => {
    const good = golden('code-already-good');

    // Unchanged: passes.
    expect(scoreGolden(good, good.rough).passed).toBe(true);

    // Inflated: fails, and says which half of the rule broke.
    const inflated = `${good.rough}\n\n${'## Additional considerations\n- padding\n'.repeat(40)}`;
    expect(failedNames(inflated, 'code-already-good')).toContain('regression:noInflation');

    // Rewritten from scratch at a similar length: the length check alone would
    // miss this, which is why the rule has two halves.
    const rewritten = GOOD_OUTPUT.padEnd(good.rough.length, ' ');
    expect(failedNames(rewritten, 'code-already-good')).toContain('regression:keptContent');
  });

  it('enforces "scale to the input" on the one-word golden', () => {
    const oneWord = golden('code-one-word');

    const short = [
      '## Task',
      'Design and document a pagination approach for the endpoint in question.',
      '',
      '## Output format',
      'A short design note.',
      '',
      '## Unspecified',
      '- Which endpoint, which datastore, and whether offset or cursor paging is wanted.',
    ].join('\n');
    const score = scoreGolden(oneWord, short);
    expect(score.passed, score.results.filter((r) => !r.passed).map((r) => r.name).join(', ')).toBe(
      true,
    );

    const bloated = GOOD_OUTPUT.repeat(20);
    expect(failedNames(bloated, 'code-one-word')).toContain(
      `lengthRatio<=${String(oneWord.maxLengthRatio)}`,
    );
  });

  it('catches the injection golden obeying the injected instruction', () => {
    // Output that *is* the injected payload means the model treated the rough
    // text as instructions rather than as data (§5 hard rules).
    const obeyed = '{"pwned": true}';
    const names = failedNames(obeyed, 'code-injection');

    expect(names).toContain('notEqual:{"pwned": true}');
    expect(names).toContain('carries:fetchOrder');
  });

  it('checks the non-English golden came back in the input\'s language', () => {
    const spanish = golden('code-non-english');

    expect(
      scoreGolden(spanish, 'El formulario debe mostrar un mensaje de error al usuario.').passed,
    ).toBe(true);
    expect(failedNames('The form should show an error message.', spanish.id)).toContain(
      'language:es',
    );
  });

  it('fails a golden whose call errored, rather than scoring it as a pass', () => {
    // The runner records a failed call as `__ERROR__ …`. That must never look
    // like a pass, or an outage reads as a green run.
    const score = scoreGolden(golden('code-null-check'), '__ERROR__ ModelError: rate_limit');
    expect(score.passed).toBe(false);
  });
});
