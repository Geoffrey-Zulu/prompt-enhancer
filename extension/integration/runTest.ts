import { resolve } from 'node:path';

import { runTests } from '@vscode/test-electron';

/**
 * Downloads a real VS Code, installs this extension into it, and runs the mocha
 * suite inside it (TDD §12).
 *
 * This exists for the handful of guarantees that cannot be checked any other
 * way: that a replace is a *single* undo step, and that a document which moved
 * mid-request is not written to. Both are §9.1 promises about someone's file, and
 * a stubbed `vscode` module can only confirm that we called the API we meant to
 * call — not what the editor then did with it.
 */
async function main(): Promise<void> {
  // This file is emitted as CommonJS into `out/integration/`, so the extension
  // root — where package.json lives — is two levels up, not one. Getting this
  // wrong points VS Code at `out/` and it silently loads no extension.
  const here = __dirname;
  const extensionDevelopmentPath = resolve(here, '..', '..');
  const extensionTestsPath = resolve(here, 'index.js');

  // A VS Code integrated terminal exports ELECTRON_RUN_AS_NODE, and inheriting
  // it makes the downloaded Code.exe start as plain Node — which then rejects
  // every VS Code flag as a bad Node option and exits 9. Stripping the leaked
  // variables is what lets this run from inside an editor as well as from CI.
  for (const leaked of [
    'ELECTRON_RUN_AS_NODE',
    'VSCODE_IPC_HOOK_CLI',
    'VSCODE_NLS_CONFIG',
    'VSCODE_CODE_CACHE_PATH',
    'VSCODE_PID',
    'VSCODE_CWD',
  ]) {
    delete process.env[leaked];
  }

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // A clean, empty window: no user settings and no other extensions, so a
    // result cannot depend on the machine it ran on.
    launchArgs: ['--disable-extensions'],
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`\nintegration run failed: ${String(error)}\n\n`);
  process.exit(1);
});
