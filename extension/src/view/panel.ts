import * as vscode from 'vscode';
import {
  DEFAULT_MODE,
  ENHANCE_MODES,
  isEnhanceMode,
  MAX_ROUGH_TEXT_CHARS,
  renderEnhancePrompt,
  type EnhanceMode,
} from '@prompt-enhancer/prompts';

import { describeFailure } from '../enhance/report.js';
import { resolveSession, type EnhanceSession } from '../enhance/session.js';
import { log } from '../log.js';
import { CancelledError, PROVIDER_LABELS } from '../providers/types.js';
import type { Services } from '../services/index.js';

/**
 * The Prompt Enhancer view: paste a rough prompt, get a structured one.
 *
 * This is the extension's home, and it exists because the original design had no
 * good answer to "where does a prompt live". It lived in an editor selection,
 * which meant enhancing code, and in a chat participant, which only exists if you
 * have Copilot Chat. Neither is where someone using Claude Code or ChatGPT
 * actually types a prompt.
 *
 * The view streams the result as it arrives (D8's streaming half, which the
 * removed chat participant used to be the only consumer of) and copies it to the
 * clipboard on completion, because pasting into a chat is the next thing that
 * happens.
 */
export class PromptEnhancerViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'promptEnhancer.panel';

  private view: vscode.WebviewView | undefined;
  /** Aborts the in-flight enhancement, if any. One at a time, by design. */
  private inFlight: AbortController | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: Services,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handle(message);
    });

    view.onDidDispose(() => {
      this.inFlight?.abort();
      this.view = undefined;
    });
  }

  /** Reveals the view and drops text into its input — used by the palette command. */
  async prefill(text: string): Promise<void> {
    await vscode.commands.executeCommand(`${PromptEnhancerViewProvider.viewId}.focus`);
    this.post({ type: 'prefill', text });
  }

  private async handle(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const request = message as { type?: unknown; text?: unknown; mode?: unknown };

    switch (request.type) {
      case 'enhance':
        await this.enhance(
          typeof request.text === 'string' ? request.text : '',
          isEnhanceMode(request.mode) ? request.mode : DEFAULT_MODE,
        );
        return;
      case 'cancel':
        this.inFlight?.abort();
        return;
      case 'copy':
        if (typeof request.text === 'string' && request.text.length > 0) {
          await vscode.env.clipboard.writeText(request.text);
          this.post({ type: 'copied' });
        }
        return;
      case 'insert':
        if (typeof request.text === 'string' && request.text.length > 0) {
          await vscode.commands.executeCommand('promptEnhancer.insertResult', request.text);
        }
        return;
      default:
        return;
    }
  }

  private async enhance(rawText: string, mode: EnhanceMode): Promise<void> {
    const roughText = rawText.trim();
    if (roughText.length === 0) {
      this.post({ type: 'failed', message: 'Type a rough prompt first.' });
      return;
    }
    if (roughText.length > MAX_ROUGH_TEXT_CHARS) {
      this.post({
        type: 'failed',
        message: `That is ${roughText.length.toLocaleString()} characters, over the ${MAX_ROUGH_TEXT_CHARS.toLocaleString()} limit.`,
      });
      return;
    }

    // Failures are rendered in the panel, not as notifications — the user is
    // looking at the panel, and a toast behind it is a message they may miss.
    // Same reasoning the removed chat renderer had, same shared §9.4 table.
    const session: EnhanceSession | undefined = await resolveSession(
      this.services,
      (error, context) => {
        const description = describeFailure(error, context);
        if (description !== undefined) {
          this.post({ type: 'failed', message: description.message, action: description.action });
        }
        return Promise.resolve();
      },
    );
    if (session === undefined) {
      return;
    }

    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;

    this.post({
      type: 'started',
      model: `${PROVIDER_LABELS[session.provider]} · ${session.model}`,
    });

    try {
      const rendered = renderEnhancePrompt({ roughText, mode });
      const chunks: string[] = [];

      for await (const delta of session.client.enhanceStream(
        rendered,
        session.model,
        controller.signal,
      )) {
        if (controller.signal.aborted) {
          break;
        }
        chunks.push(delta);
        this.post({ type: 'delta', text: delta });
      }

      if (controller.signal.aborted) {
        this.post({ type: 'cancelled' });
        return;
      }

      const enhanced = chunks.join('').trim();
      if (enhanced.length === 0) {
        this.post({ type: 'failed', message: 'The model returned nothing usable.' });
        return;
      }

      // Copied on completion: pasting into a chat is the next thing that happens,
      // and making that free is the whole point of this surface.
      await vscode.env.clipboard.writeText(enhanced);
      this.post({ type: 'finished', text: enhanced });
      log.info(`panel enhanced ${roughText.length} chars into ${enhanced.length}, copied`);
    } catch (error) {
      if (error instanceof CancelledError || controller.signal.aborted) {
        this.post({ type: 'cancelled' });
        return;
      }
      const description = describeFailure(error, {
        provider: session.provider,
        model: session.model,
      });
      this.post({
        type: 'failed',
        message: description?.message ?? 'Something went wrong.',
        action: description?.action,
      });
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = undefined;
      }
    }
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    // A nonce, and a CSP that permits nothing but this script. The panel renders
    // model output, so "what could this content do" is a real question: with no
    // remote sources and no inline handlers, the answer is nothing.
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join('');

    const modeOptions = ENHANCE_MODES.map(
      (mode) =>
        `<option value="${mode}"${mode === DEFAULT_MODE ? ' selected' : ''}>${mode}</option>`,
    ).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 10px 12px;
  }
  label { display: block; font-weight: 600; margin: 12px 0 4px; }
  label:first-of-type { margin-top: 0; }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 6px 8px;
    resize: vertical;
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  #rough { min-height: 76px; }
  #result { min-height: 220px; }
  .row { display: flex; gap: 6px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .row.spread { justify-content: space-between; }
  button {
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    padding: 5px 12px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: default; }
  select {
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
    padding: 4px 6px;
  }
  #status { min-height: 18px; margin-top: 8px; font-size: 0.9em; opacity: 0.85; }
  #status.error { color: var(--vscode-errorForeground); opacity: 1; }
  .hint { opacity: 0.7; font-size: 0.9em; margin-top: 10px; line-height: 1.45; }
  .hidden { display: none; }
</style>
</head>
<body>
  <label for="rough">Rough prompt</label>
  <textarea id="rough" placeholder="fix the landing page, make it so good"></textarea>

  <div class="row spread">
    <div class="row" style="margin-top:0">
      <select id="mode" aria-label="Mode">${modeOptions}</select>
      <button id="enhance">Enhance</button>
      <button id="cancel" class="secondary hidden">Cancel</button>
    </div>
  </div>

  <div id="status"></div>

  <label for="result">Enhanced prompt</label>
  <textarea id="result" spellcheck="false" placeholder="The result appears here, and is copied to your clipboard."></textarea>
  <div class="row">
    <button id="copy" class="secondary">Copy</button>
    <button id="insert" class="secondary">Insert into editor</button>
  </div>

  <p class="hint">Paste the result into Claude Code, ChatGPT, or any other chat.
  Editing the result before you send it is expected — it is a draft, not an oracle.</p>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const rough = document.getElementById('rough');
  const result = document.getElementById('result');
  const mode = document.getElementById('mode');
  const enhance = document.getElementById('enhance');
  const cancel = document.getElementById('cancel');
  const status = document.getElementById('status');

  // Survives the view being hidden and rebuilt, which VS Code does freely.
  const saved = vscode.getState() || {};
  rough.value = saved.rough || '';
  result.value = saved.result || '';
  if (saved.mode) { mode.value = saved.mode; }
  const save = () => vscode.setState({ rough: rough.value, result: result.value, mode: mode.value });
  rough.addEventListener('input', save);
  result.addEventListener('input', save);
  mode.addEventListener('change', save);

  const setStatus = (text, isError) => {
    status.textContent = text;
    status.className = isError ? 'error' : '';
  };
  const setRunning = (running) => {
    enhance.disabled = running;
    cancel.classList.toggle('hidden', !running);
  };

  const submit = () => {
    if (enhance.disabled) { return; }
    result.value = '';
    save();
    setStatus('');
    setRunning(true);
    vscode.postMessage({ type: 'enhance', text: rough.value, mode: mode.value });
  };

  enhance.addEventListener('click', submit);
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('copy').addEventListener('click', () =>
    vscode.postMessage({ type: 'copy', text: result.value }));
  document.getElementById('insert').addEventListener('click', () =>
    vscode.postMessage({ type: 'insert', text: result.value }));

  // Ctrl/Cmd+Enter submits, which is what every chat box has trained everyone to expect.
  rough.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'prefill':
        rough.value = message.text;
        save();
        rough.focus();
        break;
      case 'started':
        setStatus('Enhancing with ' + message.model + '…');
        break;
      case 'delta':
        result.value += message.text;
        break;
      case 'finished':
        result.value = message.text;
        save();
        setRunning(false);
        setStatus('Copied to your clipboard — paste it into your chat.');
        break;
      case 'cancelled':
        setRunning(false);
        setStatus('Cancelled.');
        break;
      case 'copied':
        setStatus('Copied to your clipboard.');
        break;
      case 'failed':
        setRunning(false);
        setStatus(message.message + (message.action ? ' (' + message.action + ')' : ''), true);
        break;
    }
  });
</script>
</body>
</html>`;
  }
}
