# Technical Design Document: Prompt Enhancer VS Code Extension

**Status:** approved for build
**Last revised:** 2026-08-19 (rev 2 — cloud proxy cut from v1)
**History:** initial draft `59d2899`; rev 1 (design review) `be9ab11`

---

## 1. Project Overview

**Name:** Prompt Enhancer

**Goal:** A VS Code extension that takes rough, unstructured text — a selection in the editor or a
chat message — runs it through an LLM, and returns a structured, context-rich prompt. In the
editor the rough text is replaced in place; in chat the result is streamed into the panel.

**Core features**

- **Editor enhancement:** keybinding replaces the highlighted text with an enhanced prompt.
- **Chat participant:** `@enhance` handles requests in the VS Code native chat panel.
- **BYOK, and only BYOK:** the user supplies their own Gemini API key, stored in VS Code
  `SecretStorage`. The extension calls Gemini directly. There is **no account, no sign-in, and no
  server** — see §2 D1.

**Non-goals for v1:** a cloud proxy or any hosted backend, multi-provider BYOK, prompt
libraries/history, workspace-wide context gathering, team/org accounts, telemetry.

---

## 2. Locked decisions

Settled. Changing one is a design change, not an implementation choice.

| # | Decision | Rationale |
|---|---|---|
| D1 | **BYOK only in v1. No backend at all.** | A proxy on the author's Gemini key needs some notion of who is calling, or it is an open endpoint billing the author for strangers. Everything that machinery cost — anonymous auth, per-caller quota, spend caps, kill switch, a Firebase project, two build phases — bought one thing: a user with no key. That user is better served by `vscode.lm` (D6) than by a bill. Cut. |
| D2 | **Single provider: Google AI (Gemini), model `gemini-2.5-flash`.** Pinned in one constant. | Two providers means two key formats, two SDKs, two sets of output quirks, twice the eval surface. |
| D3 | **The prompt template is a single authored file** in a shared workspace package. | Consumed by the extension and by the eval runner (§10), and it keeps the prompt independently testable. Prompt text never lives in TypeScript. |
| D6 | **`vscode.lm` (Copilot-backed) is the v2 answer for users without a key.** | Zero cost to the author, no auth, no abuse surface — strictly better than a proxy. Requires the user to have a chat model provider, which is why it is not the v1 default. |
| D7 | **Keybinding default is `ctrl+alt+e` / `cmd+alt+e`**, gated on `editorHasSelection`. | `ctrl+shift+e` is Focus Explorer on every platform and must not be overridden. |
| D8 | **Editor path is non-streaming; chat path streams plain text.** | Validated output and token streaming are mutually exclusive. Each flow gets the one that fits. |

D4 and D5 covered the proxy's prompt-relay defence and its anonymous-auth identity. Both are
withdrawn with the proxy; the numbering is left with gaps so older commits and reviews still
reference the right decisions.

**On sign-in generally:** no version of this extension has ever required a user to log in. The
withdrawn anonymous auth was invisible per-install attribution for the proxy's quota, not a
sign-in screen. With the proxy gone the question is moot — the user pastes a key and that is the
entire setup.

---

## 3. Repository layout

A pnpm workspace, local git repo. GitHub remote added when the repo exists.

```
prompt-enhancer/
├── extension/              # the VS Code extension (the publishable artifact)
│   ├── src/
│   │   ├── extension.ts        # activate/deactivate, registration only
│   │   ├── commands/           # enhanceSelection, setApiKey, clearApiKey
│   │   ├── chat/               # @enhance participant handler
│   │   ├── services/
│   │   │   ├── SecretService.ts    # wraps context.secrets
│   │   │   └── GeminiClient.ts     # the one and only model call
│   │   └── enhance/            # orchestration shared by both entry points
│   ├── package.json            # contributes commands, keybindings, chatParticipants
│   └── tsup.config.ts
├── packages/
│   └── prompts/            # D3: single source of truth
│       ├── templates/enhance.v1.md
│       ├── src/index.ts        # template text, version, sha256, mode enum, renderer
│       └── package.json
├── evals/goldens.jsonl     # §10 quality bar
├── pnpm-workspace.yaml
└── tdd.md
```

There is no `functions/` directory and no `firebase.json`. If the proxy is ever revived it arrives
as a v2 workstream, not as a stub carried in the meantime.

---

## 4. Architecture & tech stack

- **Language:** TypeScript, strict mode.
- **Runtime:** Node.js (VS Code extension host).
- **Engine:** `"engines": { "vscode": "^1.90.0" }` — the version that stabilised both the Chat
  participant API and `vscode.lm`.
- **Build:** `tsup`, CJS output, `external: ['vscode']`, `platform: 'node'`. The `vscode` module is
  host-injected and must never be bundled; the workspace prompts package is bundled in, since a
  `.vsix` has no `node_modules`.
- **Runtime dependencies:** none. Global `fetch` calls the Gemini REST API directly — no
  `@google/generative-ai` SDK, because one HTTP call does not justify a dependency in a shipped
  extension.
- **Secrets:** VS Code `SecretStorage` only (§7).
- **Model:** `gemini-2.5-flash` via `generativelanguage.googleapis.com/v1beta`.

The entire extension is client-side. There is no infrastructure to provision, no deploy step, and
no cost borne by the author.

---

## 5. The prompt as single source of truth

`packages/prompts` exports:

```ts
export const ENHANCE_MODES = ['code', 'architecture', 'refactor'] as const;
export type EnhanceMode = typeof ENHANCE_MODES[number];

export const TEMPLATE_VERSION = 'enhance.v1';
export const TEMPLATE_SHA256  = '<computed at build time>';
export const MODEL_ID         = 'gemini-2.5-flash';

export function renderEnhancePrompt(input: {
  roughText: string;
  context?: string;
  mode: EnhanceMode;
}): { system: string; user: string };
```

The template is authored as markdown in `templates/enhance.v1.md`, split into `<!-- SYSTEM -->`,
`<!-- USER -->`, and one `<!-- MODE:x -->` section per mode, so all prompt *text* — including the
per-mode guidance — lives in that one file and none of it is embedded in TypeScript.
`scripts/generate.mjs` inlines it into `src/generated/template.ts` at build time along with its
sha256, so nothing reads from disk at runtime and the template ships correctly inside the `.vsix`.
The generated file is not committed.

- Both entry points — the editor command and the chat participant — call `renderEnhancePrompt`.
  The eval runner (§10) is the third consumer and the reason the sha256 is worth recording: a
  golden run is reported against the exact template bytes it tested.
- Changing the template in a way that alters behaviour means bumping `TEMPLATE_VERSION`
  (`enhance.v2`) and re-running the goldens. With no server there is no version negotiation — the
  template and the code that uses it ship together in one `.vsix`.
- `ENHANCE_MODES` is a closed enum. Unknown values are rejected before any network call.

---

## 6. The model call

One outbound request, `POST` to
`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, with
the key in the `x-goog-api-key` header — never in the URL or a query string.

**Request body** — `systemInstruction` carries the rendered system text, `contents` the user text:

```json
{
  "systemInstruction": { "parts": [{ "text": "<rendered system>" }] },
  "contents": [{ "role": "user", "parts": [{ "text": "<rendered user>" }] }],
  "generationConfig": { "temperature": 0.3, "maxOutputTokens": 4096 }
}
```

Low temperature deliberately: this is a rewriting task with a required shape, not a creative one.

**Response** — the enhanced prompt is
`candidates[0].content.parts[*].text` joined. Three cases must be handled explicitly rather than
assumed away:

| Case | Handling |
|---|---|
| `candidates` empty or absent | treat as failure; do not write an empty string over the selection |
| `finishReason` is `MAX_TOKENS` | output is truncated — warn, and do not replace in place |
| `finishReason` is `SAFETY` / `promptFeedback.blockReason` set | report that the model declined; leave the document alone |

**Input caps** (enforced before the call): `rough_text` 1–20 000 chars, `context` ≤ 2 000 chars.
Rejecting an oversized selection client-side is what stops a whole-file selection from becoming a
surprise bill on the user's key.

**Streaming** — the chat path uses `:streamGenerateContent` with `alt=sse` (D8). The editor path
uses the non-streaming endpoint.

---

## 7. API key handling

The whole of the extension's security surface, now that there is no server.

- **Store:** `context.secrets.store('promptEnhancer.geminiApiKey', key)`. Keys must **never** touch
  `workspace.configuration`, workspace state, `globalState`, logs, or error messages. Settings sync
  and workspace files are the two places a key must not end up.
- **Retrieve:** `context.secrets.get(...)`, read per call, never cached in a module-level variable.
- **Commands:** "Prompt Enhancer: Set API Key" (`showInputBox` with `password: true`) and
  "Prompt Enhancer: Clear API Key".
- **Validate on set:** one minimal `GET /v1beta/models` call to confirm the key works, and report
  the result. Do not store an invalid key silently.
- **Rotation:** setting a key overwrites. Clearing removes it, and the extension then prompts for a
  key on next use rather than failing obscurely.
- **Redaction:** all logging goes through a single channel that strips `AIza…` patterns and bearer
  tokens at the boundary, so forgetting to redact at a call site is not possible (§9.3).
- **No key present** is a normal state, not an error: the first enhancement attempt shows a message
  with a "Set API Key" action, and links to where a free key comes from.

---

## 8. Workflows

### Flow A — Editor enhancement (in-place)

1. **Trigger:** user selects text, presses `ctrl+alt+e` (`cmd+alt+e` on macOS). The keybinding's
   `when` clause is `editorTextFocus && editorHasSelection`.
2. **Capture:** read `activeTextEditor.selection`; capture `document.languageId`, the selection
   range, and `document.version`. Empty or whitespace-only selection → info message, no call.
3. **Validate:** length caps and mode resolution per §5/§6.
4. **Key:** no key in `SecretStorage` → the §7 "Set API Key" prompt, and stop.
5. **Progress:** `vscode.window.withProgress` at `ProgressLocation.Notification`, cancellable.
   Cancellation aborts via `AbortController` and leaves the document untouched.
6. **Apply:** a single `editBuilder.replace()` on the *original* range, in one edit so it is one
   undo step. Before applying, verify `document.version` is unchanged and the range still matches;
   if the user edited during the request, do not replace — show the result in a preview document.
7. **Failure:** the selection is never destroyed. See §9.

### Flow B — Chat participant (`@enhance`)

1. **Contribution:** `package.json` declares `chatParticipants` with
   `id: "prompt-enhancer.enhance"`, `name: "enhance"`, `fullName`, `description`, `isSticky: true`.
2. **Registration:** `vscode.chat.createChatParticipant('prompt-enhancer.enhance', handler)` — the
   id must match the contribution exactly.
3. **Input:** `request.prompt` is the rough text. Mode comes from a slash command (`/code`,
   `/architecture`, `/refactor`), defaulting to `code`.
4. **Key:** same §7 rules. Missing key is reported in the chat stream with the same action.
5. **Output:** stream with `ChatResponseStream.markdown()` as SSE chunks arrive. Honour the
   handler's `CancellationToken`.
6. **Follow-ups:** offer "Insert into editor" and "Copy".

Both flows share one orchestration module: validate → render → call → deliver. Only the delivery
step differs.

---

## 9. Error handling & UX rules

Rules, not suggestions — these are the behaviours tests assert.

1. **A failed enhancement never modifies the document.** No partial writes, no clearing the
   selection, no writing an empty or truncated result.
2. **Errors surface as one `showErrorMessage`** with a plain-language cause and, where useful, an
   action button ("Set API Key", "Retry", "Open Output").
3. **Diagnostics go to a dedicated `OutputChannel`**, with the API key redacted unconditionally at
   the logging boundary.
4. **Mapped messages** — every one of these is a real Gemini response, not a hypothetical:

| Cause | Message |
|---|---|
| HTTP 400 `API_KEY_INVALID` | "That API key was rejected — check it or set a new one." + Set API Key |
| HTTP 403 | "The key is valid but not permitted to use this model." |
| HTTP 429 | "Gemini rate limit reached — wait a moment and retry." + Retry |
| HTTP 500/503 | "Gemini is unavailable right now." + Retry |
| `finishReason: MAX_TOKENS` | "The result was truncated — try a smaller selection." |
| `SAFETY` / `blockReason` | "The model declined to process this text." |
| No key | "Add a Gemini API key to use Prompt Enhancer." + Set API Key |

5. **Timeout:** 30 s client-side, then abort with a retry action.
6. **Offline** is detected and reported as offline, not as a generic failure.
7. **Never surface a raw HTTP body or stack trace to the user.** It goes to the output channel.

---

## 10. Quality bar

Without this, every prompt change is unfalsifiable.

- `evals/goldens.jsonl` holds **15+ rough → expected-shape pairs** spanning all three modes,
  including adversarial inputs: a one-word selection, a 500-line paste, a selection that is already
  a good prompt, a non-English selection, and a selection containing prompt-injection text.
- Each golden asserts *structural* properties, not exact text: the output states a role, states the
  task, lists constraints, names the expected output format, and does not invent requirements
  absent from the input.
- The runner reports pass rate against `TEMPLATE_SHA256`, so a result is traceable to exact
  template bytes. Any `TEMPLATE_VERSION` bump requires a run, recorded in the PR.
- **Regression rule:** the already-good-prompt golden must come back materially unchanged. An
  enhancer that inflates good prompts is worse than no enhancer.
- The runner needs a real key and costs real tokens, so it is run deliberately, not on every commit.

---

## 11. Build order

Sequential. Each phase ends in a working, committed, reviewable state on its own branch.

**Phase 1 — Repo & extension scaffold** ✅ complete

1. `git init`, `.gitignore`, `.gitattributes`, `main` branch.
2. pnpm workspace: `extension/`, `packages/prompts/`, root configs, shared `tsconfig.base.json`.
3. `extension/package.json` with engine `^1.90.0`, and the `enhanceSelection` command, its
   keybinding (D7), and a context-menu entry.
4. `tsup` config, strict `tsconfig`, `src/extension.ts` doing registration only, and a redacting
   `OutputChannel` (§9.3).
5. `packages/prompts` with the mode enum, version constant, `renderEnhancePrompt`, and the real
   system instruction in `templates/enhance.v1.md`.
6. Verify: builds clean, unit tests pass, extension activates in the Extension Development Host,
   the command renders a prompt from a live selection.

**Phase 2 — BYOK end to end**
`SecretService`, the two key commands with live validation, `GeminiClient`, Flow A wired to the
editor including every §9 rule, the §6 response edge cases, and the Flow A.6 document-version
guard. This is the first shippable version — and with the proxy cut, it is the whole product minus
chat.

**Phase 3 — Chat participant**
Flow B, SSE streaming, slash-command modes, follow-ups, cancellation.

**Phase 4 — Evals, tests, packaging**
Golden set and runner, `@vscode/test-electron` suite, CI, `vsce` packaging, README with the §13
privacy disclosure.

Former Phases 4 and 5 were the Firebase backend and the proxy client. Both are withdrawn to v2
(§14). Phase 6 is renumbered to Phase 4; no other phase changes.

**Contribution rule (applies to every phase):** a `package.json` contribution lands in the same
phase as its implementation. Declaring `chatParticipants` before Flow B exists would put a broken
`@enhance` in the chat panel, and declaring the key commands early would put dead entries in the
command palette. So `promptEnhancer.setApiKey` / `clearApiKey` arrive in Phase 2 and
`chatParticipants` in Phase 3.

---

## 12. Testing

- **Unit** (vitest): `renderEnhancePrompt` determinism, mode validation, length caps, HTTP error
  mapping, response-shape edge cases from §6, key redaction in logs.
- **Integration** (`@vscode/test-electron`): command registration, selection replace as a single
  undo step, document-changed-during-request guard, cancellation leaves the buffer untouched, chat
  participant resolves and streams, no-key path shows the action.
- **Evals:** the §10 golden runner, run deliberately on template changes.
- **Manual smoke before release:** valid key, invalid key, no key, offline, rate-limited, an
  oversized selection, and a selection edited mid-request.

No backend means no emulator, no deploy testing, and no Genkit Developer UI in the loop.

---

## 13. Branching, CI, and publishing

- **Branching:** `main` is protected and always releasable. All work happens on `feature/*` or
  `fix/*` branches and lands via pull request — never pushed directly to `main`. No remote yet;
  branches are local until the GitHub repo exists.
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- **CI (once remote exists):** lint, typecheck, unit + integration tests on PR; `vsce package`
  artifact on `main`. The eval runner is not in CI — it needs a real key.
- **Publishing:** VS Code Marketplace via `vsce`. Requires a publisher ID and a PAT — an external
  step for the repo owner.
- **Privacy disclosure (required in the README and the Marketplace listing):** the text you select
  is sent to Google's Gemini API using your own API key, and nowhere else. The extension has no
  server, collects no telemetry, and the author never sees your text or your key. The key is held
  in the OS credential store via VS Code `SecretStorage`.

That disclosure being three sentences instead of a paragraph of caveats is the clearest measure of
what cutting the proxy bought.

---

## 14. Deferred to v2

- **`vscode.lm` / Copilot-backed access** (D6) — the intended answer for users without a key, and
  the first thing to build after v1 ships.
- **The cloud proxy**, if it is ever wanted: it returns as a whole workstream — Firebase Functions
  v2, Genkit, `defineSecret`, a template-version allowlist so old installs keep working, per-caller
  quota, a global spend cap, `maxInstances`, a kill switch, a billing alert, and an identity
  mechanism. Anonymous Firebase Auth (not deprecated, and with opt-in 30-day cleanup it does not
  count toward billing quotas) is the cheapest option; GitHub OAuth is the honest one. The reason
  it was cut is that all of it exists to serve users who could instead use D6 for free.
- Additional BYOK providers including Anthropic; prompt history and a saved-prompt library;
  workspace-aware context beyond `languageId`; team/org key management; usage telemetry.
