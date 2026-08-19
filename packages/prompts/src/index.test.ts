import { describe, expect, it } from 'vitest';

import {
  ENHANCE_MODES,
  MAX_ROUGH_TEXT_CHARS,
  PromptInputError,
  renderEnhancePrompt,
  type EnhanceMode,
} from './index.js';

describe('renderEnhancePrompt', () => {
  it('is deterministic — the BYOK and proxy paths must agree byte for byte', () => {
    const input = { roughText: 'make the login form validate email', mode: 'code' as const };
    expect(renderEnhancePrompt(input)).toEqual(renderEnhancePrompt(input));
  });

  it('inlines the guidance for every mode, and only that mode', () => {
    for (const mode of ENHANCE_MODES) {
      const { system } = renderEnhancePrompt({ roughText: 'x', mode });
      expect(system).toContain(`**${mode}**`);
      expect(system).not.toContain('{{');
    }
  });

  it('carries the rough text through verbatim', () => {
    const roughText = 'fix NullPointerException in UserRepo.findById(id) at line 42';
    const { user } = renderEnhancePrompt({ roughText, mode: 'refactor' });
    expect(user).toContain(roughText);
  });

  it('omits the context heading when no context is given', () => {
    const without = renderEnhancePrompt({ roughText: 'x', mode: 'code' });
    expect(without.user).not.toContain('## Context');

    const withContext = renderEnhancePrompt({
      roughText: 'x',
      context: 'language: typescript',
      mode: 'code',
    });
    expect(withContext.user).toContain('## Context');
    expect(withContext.user).toContain('language: typescript');
  });

  it('does not let rough text inject a placeholder', () => {
    const { user } = renderEnhancePrompt({ roughText: '{{MODE_GUIDANCE}}', mode: 'code' });
    expect(user).toContain('{{MODE_GUIDANCE}}');
  });

  it('rejects empty, oversized, and unknown-mode input', () => {
    expect(() => renderEnhancePrompt({ roughText: '   ', mode: 'code' })).toThrow(PromptInputError);
    expect(() =>
      renderEnhancePrompt({ roughText: 'a'.repeat(MAX_ROUGH_TEXT_CHARS + 1), mode: 'code' }),
    ).toThrow(PromptInputError);
    expect(() =>
      renderEnhancePrompt({ roughText: 'x', mode: 'poetry' as unknown as EnhanceMode }),
    ).toThrow(PromptInputError);
  });
});
