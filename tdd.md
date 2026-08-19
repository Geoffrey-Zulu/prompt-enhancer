# Technical Design Document: Prompt Enhancer VS Code Extension

**Status:** approved for build
**Last revised:** 2026-08-19
**Supersedes:** initial draft, preserved as commit `59d2899`

---

## 1. Project Overview

**Name:** Prompt Enhancer

**Goal:** A VS Code extension that takes rough, unstructured text — a selection in the
editor or a chat message — runs it through an LLM, and returns a structured, context-rich
prompt. In the editor the rough text is replaced in place; in chat the result is streamed
into the panel.

**Core features**

- **Editor enhancement:** keybinding replaces the highlighted text with an enhanced prompt.
- **Chat participant:** `@enhance` handles requests in the VS Code native chat panel.
- **Hybrid model access:**
  - **BYOK** — user's own Gemini API key, stored in VS Code `SecretStorage`, called directly.
  - **Cloud proxy** — Firebase Functions v2 + Genkit, using an enterprise key, for users
    who have no key of their own.

**Non-goals for v1:** multi-provider BYOK, prompt libraries/history, workspace-wide context
gathering, team/org accounts, telemetry dashboards.

---

## 2. Locked decisions

These were open in the draft. They are now settled; changing one is a design change, not an
implementation choice.

| # | Decision | Rationale |
|---|---|---|
| D1 | **BYOK and cloud proxy both ship in v1.** BYOK is the default when a key is present. | Chosen scope. Keeps the extension useful for users without Copilot or a key. |
| D2 | **Single provider: Google AI (Gemini), model `gemini-2.5-flash`.** Pinned in one constant, shared by both paths. | Two providers means two key formats, two SDKs, two sets of output quirks, twice the eval surface. |
| D3 | **The prompt template lives in the extension repo as the single source of truth**, in a shared workspace package consumed by both the extension and the backend. | Avoids the drift the draft had, where BYOK had no template and the server owned the logic. |
| D4 | **The proxy never accepts a client-supplied prompt.** The client sends `template_version` + raw inputs; the server renders from its own copy of the template. | A prompt-relay endpoint on an enterprise key is a free Gemini proxy for anyone who unzips the `.vsix`. |
| D5 | **Proxy identity is Firebase Anonymous Auth**, per install, with a hard per-`uid` daily quota. | The only auth that actually works with `onCall`, and it needs no user-visible sign-in. See §7 for its honest limits. |
| D6 | **`vscode.lm` (Copilot-backed) is deferred to v2.** | Considered and set aside; it would remove keys entirely but requires the user to have a chat model provider. Revisit once BYOK + proxy are shipping. |
| D7 | **Keybinding default is `ctrl+alt+e` / `cmd+alt+e`**, gated on `editorHasSelection`. | The draft's `Cmd+Shift+E` is Focus Explorer on every platform and must not be overridden. |
| D8 | **Editor path is non-streaming; chat path streams plain text.** | Structured/validated output and token streaming are mutually exclusive. Each flow gets the one that fits. |

---

## 3. Repository layout

A pnpm workspace. Local git repo now; GitHub remote added when the repo exists.

```
prompt-enhancer/
├── extension/              # the VS Code extension (the publishable artifact)
│   ├── src/
│   │   ├── extension.ts        # activate/deactivate, registration only
│   │   ├── commands/           # enhanceSelection, setApiKey, clearApiKey
│   │   ├── chat/               # @enhance participant handler
│   │   ├── services/
│   │   │   ├── SecretService.ts    # wraps context.secrets
│   │   │   ├── ApiClient.ts        # routes BYOK vs proxy
│   │   │   ├── GeminiDirect.ts     # BYOK: direct generateContent call
│   │   │   └── ProxyClient.ts      # anon auth + onCall request
│   │   └── enhance/            # shared orchestration used by both entry points
│   ├── package.json            # contributes commands, keybindings, chatParticipants
│   └── tsup.config.ts
├── functions/              # Firebase Functions v2 + Genkit
│   ├── src/index.ts
│   └── package.json
├── packages/
│   └── prompts/            # D3: single source of truth
│       ├── templates/enhance.v1.md
│       ├── src/index.ts        # exports template text, version id, sha256, mode enum
│       └── package.json
├── evals/goldens.jsonl     # §10 quality bar
├── pnpm-workspace.yaml
├── firebase.json
└── tdd.md
```

`functions/` depends on `@prompt-enhancer/prompts` as a workspace dependency, so the template
is copied into the deploy bundle at build time from the one source file. No second authored
copy exists.

---

## 4. Architecture & tech stack

### Extension (client)

- **Language:** TypeScript, strict mode.
- **Runtime:** Node.js (VS Code extension host).
- **Engine:** `"engines": { "vscode": "^1.90.0" }` — the version that stabilised both the
  Chat participant API and `vscode.lm`.
- **Build:** `tsup`, CJS output, `external: ['vscode']`, `platform: 'node'`. The `vscode`
  module is host-injected and must never be bundled.
- **Dependencies:** none at runtime beyond the shared prompts package. Uses global `fetch`.

### Backend (GCP / Firebase)

- **Compute:** Firebase Functions v2 `onCall`, Node 20, `maxInstances` capped (§7).
- **AI framework:** Genkit with `@genkit-ai/googleai`, `zod` for I/O schemas.
- **Prompt handling:** the flow imports the template from `@prompt-enhancer/prompts` and
  renders it server-side. Genkit's `dotprompt` / `.prompt` files are **not** used — they
  would be a second authored copy of the template, violating D3.
- **Secrets:** `defineSecret('LLM_API_KEY')` → Google Cloud Secret Manager.
- **Quota state:** Firestore, one document per anonymous `uid`.

---

## 5. The prompt as single source of truth

`packages/prompts` exports:

```ts
export const ENHANCE_MODES = ['code', 'architecture', 'refactor'] as const;
export type EnhanceMode = typeof ENHANCE_MODES[number];

export const TEMPLATE_VERSION = 'enhance.v1';
export const TEMPLATE_SHA256  = '<computed at build time>';

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
sha256, so nothing reads from disk at runtime and the template ships correctly inside both a
`.vsix` bundle and a Cloud Functions deploy. The generated file is not committed.

- The BYOK path calls `renderEnhancePrompt` locally and sends the result to Gemini.
- The proxy path sends `{ rough_text, context, mode, template_version }`. The server calls
  the *same* function from its own copy of the package. Identical output, one authored file.
- Changing the template means bumping `TEMPLATE_VERSION` (`enhance.v2`) and shipping both an
  extension release and a function deploy. The server keeps an allowlist of accepted versions
  so older installs keep working during rollout.
- `ENHANCE_MODES` is a closed enum (resolves the draft's undefined `mode`). Unknown values are
  rejected client-side before any network call.

---

## 6. Data contracts

Firebase `onCall` wraps request bodies in `data` and responses in `result`.

**Request (client → function)**

```json
{
  "data": {
    "rough_text": "string, required, 1..20000 chars",
    "context": "string, optional, <=2000 chars — e.g. languageId, file path",
    "mode": "'code' | 'architecture' | 'refactor'",
    "template_version": "string, e.g. 'enhance.v1'"
  }
}
```

**Response (function → client)**

```json
{
  "result": {
    "enhanced_prompt": "string",
    "template_version": "string",
    "tokens_used": 0
  }
}
```

**Error response** — standard `HttpsError` codes, mapped to user-facing messages in §9:

| Code | Meaning |
|---|---|
| `unauthenticated` | missing or invalid Firebase ID token |
| `invalid-argument` | schema violation, or `template_version` not in the server allowlist |
| `resource-exhausted` | per-`uid` daily quota spent |
| `deadline-exceeded` | upstream model timeout |
| `internal` | anything else; details never leaked to the client |

**Input caps** are enforced in both places. `rough_text` over 20 000 characters is rejected
client-side with a message telling the user to narrow the selection — this is what stops a
whole-file selection from becoming a surprise bill.

---

## 7. Authentication & abuse control

The draft offered `Authorization: Bearer <token>` "or a custom header `X-Extension-Auth`".
Neither works:

- `onCall` treats `Authorization: Bearer` strictly as a **Firebase Auth ID token** and rejects
  anything else as `unauthenticated`. The draft had no sign-in flow, so every call would have
  arrived unauthenticated.
- A custom header *is* readable via `request.rawRequest.headers`, but a shared secret shipped
  inside a published `.vsix` is extractable by anyone. That is obfuscation, not auth.
- Firebase App Check cannot help: the extension host has no supported attestation provider.

**The design:**

1. On first proxy use, `ProxyClient` signs in anonymously via the Identity Toolkit REST
   endpoint (`accounts:signUp`) using the Firebase **Web API key** — which is public by design
   and safe to ship.
2. The returned refresh token is stored in `SecretStorage`; ID tokens are refreshed on demand
   and held in memory only.
3. Requests send the ID token as `Authorization: Bearer`, so `request.auth.uid` is populated
   and gives a stable per-install identity.
4. The flow checks and increments a Firestore counter for that `uid` before calling the model.
   Over the daily cap → `resource-exhausted`.

**Stated honestly:** anonymous auth gives *attribution and rate limiting*, not identity.
Anyone can mint fresh `uid`s and reset their own quota. It raises the cost of abuse without
eliminating it. The remaining defences are therefore non-optional:

- `maxInstances` on the function, sized to a cost ceiling rather than to demand.
- A GCP billing budget with an alert, and a documented kill switch (unset the secret, or set a
  `proxy_enabled: false` flag the flow reads) so the proxy can be disabled without an
  extension release.
- A global daily spend cap enforced in the flow, independent of per-`uid` caps.

If proxy abuse becomes real, the escalation is GitHub OAuth sign-in for proxy access — a v2
item, not a v1 blocker.

---

## 8. Workflows

### Flow A — Editor enhancement (in-place)

1. **Trigger:** user selects text, presses `ctrl+alt+e` (`cmd+alt+e` on macOS). The
   keybinding's `when` clause is `editorTextFocus && editorHasSelection`.
2. **Capture:** read `activeTextEditor.selection`; capture `document.languageId` and the
   selection range. Empty or whitespace-only selection → info message, no call.
3. **Validate:** length caps and mode resolution per §5/§6.
4. **Route:** key in `SecretStorage` → `GeminiDirect`. No key → `ProxyClient`. If neither is
   available (no key, proxy disabled) → prompt the user to set a key.
5. **Progress:** `vscode.window.withProgress` at `ProgressLocation.Notification`, cancellable.
   Cancellation aborts the request via `AbortController` and leaves the document untouched.
6. **Apply:** a single `editBuilder.replace()` on the *original* range, in one edit so it is
   one undo step. Before applying, verify the document version and that the range still
   matches what was captured; if the user has edited in the meantime, do not replace — show
   the result in a preview document instead.
7. **Failure:** the selection is never destroyed. See §9.

### Flow B — Chat participant (`@enhance`)

1. **Contribution:** `package.json` declares `chatParticipants` with
   `id: "prompt-enhancer.enhance"`, `name: "enhance"`, `fullName`, `description`, and
   `isSticky: true`.
2. **Registration:** `vscode.chat.createChatParticipant('prompt-enhancer.enhance', handler)` —
   the id must match the contribution exactly.
3. **Input:** `request.prompt` is the rough text. `mode` comes from a slash command (`/code`,
   `/architecture`, `/refactor`), defaulting to `code`.
4. **Route:** same `ApiClient` as Flow A.
5. **Output:** stream with `ChatResponseStream.markdown()` as chunks arrive (D8: plain text, no
   output-schema validation on this path). Honour the handler's `CancellationToken`.
6. **Follow-ups:** offer "Insert into editor" and "Copy" as follow-up actions.

### Flow C — BYOK key handling

- **Store:** `context.secrets.store('promptEnhancer.geminiApiKey', key)`. Keys must **never**
  touch `workspace.configuration`, workspace state, logs, or error messages.
- **Retrieve:** `context.secrets.get(...)`, read per call, never cached in a module-level
  variable.
- **Commands:** "Prompt Enhancer: Set API Key" (`showInputBox` with `password: true`) and
  "Prompt Enhancer: Clear API Key".
- **Validation:** on set, make one minimal `models.list` call to confirm the key works, and
  report the result. Do not store an invalid key silently.
- **Rotation:** setting a key overwrites; clearing falls the user back to the proxy.

---

## 9. Error handling & UX rules

Rules, not suggestions — these are the behaviours tests assert.

1. **A failed enhancement never modifies the document.** No partial writes, no clearing the
   selection.
2. **Errors surface as one `showErrorMessage`** with a plain-language cause and, where useful,
   an action button ("Set API Key", "Retry", "Open Output").
3. **Diagnostics go to a dedicated `OutputChannel`**, with the API key redacted
   unconditionally at the logging boundary.
4. **Mapped messages:** `unauthenticated` → "Sign-in to the enhancement service failed";
   `resource-exhausted` → "Daily free limit reached — add your own API key to continue";
   `invalid-argument` on template version → "Please update the Prompt Enhancer extension".
5. **Timeout:** 30 s client-side, then abort with a retry action.
6. **Offline** is detected and reported as offline, not as a generic failure.

---

## 10. Quality bar

The draft had no definition of "enhanced", which makes every prompt change unfalsifiable.

- `evals/goldens.jsonl` holds **15+ rough → expected-shape pairs** spanning all three modes,
  including adversarial inputs: a one-word selection, a 500-line paste, a selection that is
  already a good prompt, and a non-English selection.
- Each golden asserts *structural* properties, not exact text: the output states a role, states
  the task, lists constraints, names the expected output format, and does not invent
  requirements absent from the input.
- A script runs the goldens against the current template and reports pass rate. Any
  `TEMPLATE_VERSION` bump requires a run, and the result is recorded in the PR.
- **Regression rule:** the already-good-prompt golden must come back materially unchanged. An
  enhancer that inflates good prompts is worse than no enhancer.

---

## 11. Build order

Sequential. Each phase ends in a working, committed, reviewable state on its own branch.

**Phase 1 — Repo & extension scaffold** *(current)*

1. `git init`, `.gitignore`, `main` branch, initial commit of this document.
2. pnpm workspace: `extension/`, `packages/prompts/`, root configs, shared `tsconfig.base.json`.
3. `extension/package.json` with engine `^1.90.0`, and the `enhanceSelection` command, its
   keybinding (D7), and a context-menu entry.
4. `tsup` config, strict `tsconfig`, `src/extension.ts` doing registration only, and a redacting
   `OutputChannel` (§9.3).
5. `packages/prompts` with the mode enum, version constant, `renderEnhancePrompt`, and the real
   system instruction in `templates/enhance.v1.md`.
6. Verify: builds clean, unit tests pass, extension activates in the Extension Development Host,
   the command renders a prompt from a live selection.

**Contribution rule (applies to every phase):** a `package.json` contribution lands in the same
phase as its implementation. Declaring `chatParticipants` before Flow B exists would put a
broken `@enhance` in the chat panel, and declaring the key commands early would put dead entries
in the command palette. So `promptEnhancer.setApiKey` / `clearApiKey` arrive in Phase 2 and
`chatParticipants` in Phase 3.

**Phase 2 — BYOK end to end**
`SecretService`, the two key commands with validation, `GeminiDirect`, Flow A wired to the
editor including the §9 error rules and the §8.A.6 document-version guard. First genuinely
usable version, no backend involved.

**Phase 3 — Chat participant**
Flow B, streaming, slash-command modes, follow-ups, cancellation.

**Phase 4 — Backend**
Firebase init, Genkit + `googleai`, `defineSecret`, the flow importing
`@prompt-enhancer/prompts`, zod schemas matching §6, template-version allowlist, Firestore
quota, `maxInstances`, kill switch, budget alert.

**Phase 5 — Proxy client**
Anonymous auth + refresh-token storage, `ProxyClient`, routing fallback in `ApiClient`,
`resource-exhausted` UX.

**Phase 6 — Evals, tests, packaging**
Golden set and runner, `@vscode/test-electron` suite, CI, `vsce` packaging, README with the
privacy disclosure from §13.

---

## 12. Testing

- **Unit** (vitest): `renderEnhancePrompt` determinism, mode validation, length caps, error
  mapping, key redaction in logs.
- **Integration** (`@vscode/test-electron`): command registration, selection replace as a single
  undo step, document-changed-during-request guard, cancellation leaves the buffer untouched,
  chat participant resolves and streams.
- **Backend:** Genkit Developer UI (`genkit start`) for flow iteration; unit tests over the
  quota logic and the template allowlist with the model call stubbed.
- **Evals:** the §10 golden runner. Not a pass/fail gate on every commit; required on template
  changes.
- **Manual smoke before release:** BYOK path, proxy path, no-key path, offline, quota exhausted,
  invalid key.

---

## 13. Branching, CI, and publishing

- **Branching:** `main` is protected and always releasable. All work happens on `feature/*` or
  `fix/*` branches and lands via pull request — never pushed directly to `main`. No remote yet;
  branches are local until the GitHub repo exists.
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- **CI (once remote exists):** lint, typecheck, unit + integration tests on PR; `vsce package`
  artifact on `main`.
- **Publishing:** VS Code Marketplace via `vsce`. Requires a publisher ID and a PAT — an
  external step for the repo owner, not automatable here.
- **Privacy disclosure (required in the README and the Marketplace listing):** the BYOK path
  sends the selected text to Google's Gemini API using the user's own key; the proxy path sends
  the selected text to a Firebase Function operated by the extension author and from there to
  Gemini. No text is stored server-side beyond the request lifetime, and only aggregate
  per-`uid` request counts are persisted. Users who cannot send code off-machine should not
  enable the proxy.

---

## 14. Deferred to v2

`vscode.lm` / Copilot-backed access (D6); additional BYOK providers including Anthropic; GitHub
OAuth for proxy access; prompt history and a saved-prompt library; workspace-aware context
gathering beyond `languageId`; team/org key management; usage telemetry.
