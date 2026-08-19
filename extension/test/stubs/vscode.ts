/**
 * A stand-in for the host-injected `vscode` module, aliased in by
 * `vitest.config.ts`.
 *
 * The unit suite covers the parts of the extension that must be right before
 * any editor is involved- key-prefix detection, error mapping, response
 * parsing, cap enforcement, redaction- and those modules only ever import
 * `vscode` transitively. This stub exists so importing them does not fail; the
 * behaviour that genuinely needs a live editor is the
 * `@vscode/test-electron` suite's job (§12).
 *
 * Anything a test actually exercises should be added here deliberately, not
 * faked broadly enough to make a bad test pass.
 */

class Disposable {
  dispose(): void {
    // no-op
  }
}

export const window = {
  createOutputChannel(): unknown {
    const noop = (): void => {
      // Messages are dropped; `log.test.ts` tests `redact` directly.
    };
    return { info: noop, warn: noop, error: noop, show: noop, dispose: noop };
  },
  showInformationMessage(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  showWarningMessage(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
  showErrorMessage(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
};

export const workspace = {
  getConfiguration(): unknown {
    return { get: (): undefined => undefined };
  },
};

export const commands = {
  executeCommand(): Promise<undefined> {
    return Promise.resolve(undefined);
  },
};

export const ProgressLocation = { Notification: 15 } as const;

export { Disposable };
