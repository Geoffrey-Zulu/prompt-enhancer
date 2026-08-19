import { resolve } from 'node:path';

import Mocha from 'mocha';

/**
 * The entry point VS Code loads inside the test instance. Its `run` export is
 * the contract `@vscode/test-electron` expects.
 */
export function run(): Promise<void> {
  // This file is emitted as CommonJS for the extension host to load.
  const here = __dirname;

  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    // A real editor is slower than a unit test, and an enhancement that has to
    // open documents is slower still. Generous rather than flaky.
    timeout: 30_000,
  });

  // Listed explicitly rather than globbed: a suite file that silently stops
  // being discovered is a test that silently stops running.
  mocha.addFile(resolve(here, 'flowA.test.js'));
  mocha.addFile(resolve(here, 'registration.test.js'));

  return new Promise((resolvePromise, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed`));
        } else {
          resolvePromise();
        }
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
