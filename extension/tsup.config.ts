import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  // `vscode` is injected by the extension host and must never be bundled.
  external: ['vscode'],
  // The prompts package is workspace-local, so it is bundled in rather than
  // resolved at runtime — the .vsix has no node_modules.
  noExternal: ['@prompt-enhancer/prompts'],
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
});
