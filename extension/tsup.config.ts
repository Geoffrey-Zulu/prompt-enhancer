import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  // `vscode` is injected by the extension host and must never be bundled.
  external: ['vscode'],
  // A .vsix has no node_modules, so everything the extension needs at runtime
  // is bundled in: the workspace prompts package and each provider SDK (§4).
  // tsup treats `dependencies` as external by default, which is exactly wrong
  // here — a missing entry in this list ships an extension that cannot resolve
  // its own SDK.
  noExternal: ['@prompt-enhancer/prompts', '@anthropic-ai/sdk', 'openai', '@google/genai'],
  sourcemap: true,
  clean: true,
  dts: false,
  minify: false,
});
