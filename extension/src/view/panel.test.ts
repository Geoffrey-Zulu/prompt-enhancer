import { ENHANCE_MODES } from '@prompt-enhancer/prompts';
import { describe, expect, it } from 'vitest';

import { renderPanelHtml } from './panel.js';

/**
 * The panel's script is a string as far as TypeScript is concerned. **tsc does
 * not check it, and the unit suite would never load it**, so a syntax error in
 * there ships as a panel that renders and quietly does nothing - no error, no
 * failing test, just dead buttons.
 *
 * These tests are the only thing standing between that and a release.
 */

const NONCE = 'testnonce0123456789';
const CSP_SOURCE = 'vscode-resource://test';
const html = renderPanelHtml(CSP_SOURCE, NONCE);

/** The contents of the single inline `<script>` block. */
function scriptBody(source: string): string {
  const open = source.indexOf('<script ');
  const close = source.indexOf('</script>', open);
  expect(open, 'the panel should have exactly one inline script').toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return source.slice(source.indexOf('>', open) + 1, close);
}

describe('the panel script', () => {
  it('parses', () => {
    // `new Function` compiles without executing, which is what is wanted: the
    // script calls `acquireVsCodeApi()` and touches the DOM, neither of which
    // exists here, but neither of which affects whether it is valid JavaScript.
    expect(() => new Function(scriptBody(html))).not.toThrow();
  });

  it('wires every control the markup declares', () => {
    // A renamed id is the other way this breaks silently: the element exists, the
    // listener attaches to null, and the button does nothing.
    const body = scriptBody(html);
    for (const id of [
      'rough',
      'result',
      'mode',
      'enhance',
      'cancel',
      'status',
      'statusText',
      'statusAction',
      'setup',
      'setupSummary',
      'setKey',
      'changeModel',
      'clearKey',
      'copy',
      'insert',
    ]) {
      expect(html, `#${id} is not in the markup`).toContain(`id="${id}"`);
      expect(body, `#${id} is never looked up by the script`).toContain(`'${id}'`);
    }
  });

  it('handles every message the provider sends', () => {
    const body = scriptBody(html);
    for (const type of [
      'state',
      'prefill',
      'started',
      'delta',
      'finished',
      'cancelled',
      'copied',
      'failed',
    ]) {
      expect(body, `no handler for a "${type}" message`).toContain(`case '${type}'`);
    }
  });

  it('offers every mode the prompt package defines', () => {
    // §5's enum is closed and lives in one place; the panel must not drift from it.
    for (const mode of ENHANCE_MODES) {
      expect(html).toContain(`<option value="${mode}"`);
    }
  });
});

describe('the panel content security policy', () => {
  it('permits the script only by nonce, and nothing remote at all', () => {
    // The panel renders model output. "What could this content do" is a real
    // question, and the answer needs to stay "nothing".
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${NONCE}'`);
    expect(html).toContain(`style-src ${CSP_SOURCE}`);

    // `unsafe-inline` on styles is fine and necessary; on scripts it would undo
    // the nonce entirely.
    expect(html).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(html).not.toMatch(/script-src[^;]*unsafe-eval/);
  });

  it('carries the nonce on the script tag, or the CSP would block it', () => {
    expect(html).toContain(`<script nonce="${NONCE}">`);
  });

  it('uses no inline event handlers, which the CSP would refuse anyway', () => {
    expect(html).not.toMatch(/\son(click|change|input|load|submit)=/i);
  });
});
