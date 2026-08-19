import * as vscode from 'vscode';

/**
 * The extension's only logging surface (TDD §9.3).
 *
 * Every message passes through `redact`, so an API key cannot reach the log
 * even if it is accidentally interpolated into a message or an error. The
 * redaction lives at this boundary rather than at call sites precisely so that
 * forgetting it at a call site is not possible.
 */

let channel: vscode.LogOutputChannel | undefined;

/**
 * One pattern per supported provider key shape (TDD §7). Anthropic's `sk-ant-`
 * is listed before the general `sk-` so the more specific match wins — the same
 * ordering trap as provider detection in `providers/registry.ts`.
 *
 * Adding a provider means adding its shape here. `extension/src/log.test.ts`
 * asserts every supported prefix is stripped, so a forgotten pattern fails a
 * test rather than leaking a key into the output channel.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /AIza[0-9A-Za-z_-]{10,}/g, // Google AI
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI (incl. sk-proj-)
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
];

export function redact(text: string): string {
  return KEY_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[redacted]'), text);
}

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  channel = vscode.window.createOutputChannel('Prompt Enhancer', { log: true });
  context.subscriptions.push(channel);
  return channel;
}

export const log = {
  info(message: string): void {
    channel?.info(redact(message));
  },
  warn(message: string): void {
    channel?.warn(redact(message));
  },
  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');
    channel?.error(redact(detail.length > 0 ? `${message} — ${detail}` : message));
  },
  show(): void {
    channel?.show(true);
  },
};
