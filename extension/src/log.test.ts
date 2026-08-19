import { describe, expect, it } from 'vitest';

import { redact } from './log.js';

/**
 * §7 / §9.3: every supported key shape is stripped at the logging boundary, so
 * forgetting to redact at a call site is not possible. Adding a provider means
 * adding its pattern to `log.ts` — and this test is what fails if it is
 * forgotten, instead of a key appearing in someone's output channel.
 */
describe('redact', () => {
  const keys = {
    anthropic: 'sk-ant-api03-Zt4Kq9Lm2Rw8Xv1Nc6Bh3Jd7Fs0Gy5Pa',
    openai: 'sk-proj-Qw9Er7Ty5Ui3Op1As2Df4Gh6Jk8Lz0Xc',
    openaiLegacy: 'sk-Mn4Bv6Cx8Zl0Kj2Hg4Fd6Sa8Pq1Wo3Ei5',
    google: 'AIzaSyD-9tK3Lm2Rw8Xv1Nc6Bh3Jd7Fs0Gy5Pa',
  };

  it('strips every supported key shape', () => {
    for (const [provider, key] of Object.entries(keys)) {
      const output = redact(`calling out with ${key} attached`);
      expect(output, provider).not.toContain(key);
      expect(output, provider).toContain('[redacted]');
    }
  });

  it('strips a key however it is embedded', () => {
    const key = keys.anthropic;
    for (const line of [key, `{"apiKey":"${key}"}`, `x-api-key: ${key}\nnext line`, `${key} ${key}`]) {
      expect(redact(line)).not.toContain(key);
    }
  });

  it('strips bearer tokens', () => {
    expect(redact('Authorization: Bearer abc123.def456.ghi789')).not.toContain('abc123');
  });

  it('leaves ordinary diagnostics alone', () => {
    const line = 'enhancing 412 chars via anthropic/some-model-id (enhance.v1, mode code)';
    expect(redact(line)).toBe(line);
  });
});
