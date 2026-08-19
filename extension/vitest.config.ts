import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `vscode` is injected by the extension host and does not exist on disk, so the
 * unit suite aliases it to a stub. The tests here deliberately cover only the
 * logic that is testable without an editor (§12); the editor behaviour is the
 * `@vscode/test-electron` suite's job in Phase 5.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/stubs/vscode.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
