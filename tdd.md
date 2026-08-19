# Technical Design Document: Prompt Enhancer VS Code Extension

**Status:** approved for build
**Last revised:** 2026-08-19 (rev 4 — multi-provider)
**History:** initial draft `59d2899`; rev 1 (design review) `be9ab11`; rev 2 (proxy cut) `cfef000`;
rev 3 (Anthropic) `e80135d`

---

## 1. Project Overview

**Name:** Prompt Enhancer

**Goal:** A VS Code extension that takes rough, unstructured text — a selection in the editor or a
chat message — runs it through an LLM, and returns a structured, context-rich prompt. In the
editor the rough text is replaced in place; in chat the result is streamed into the panel.

**Core features**

- **Editor enhancement:** keybinding replaces the highlighted text with an enhanced prompt.
- **Chat participant:** `@enhance` handles requests in the VS Code native chat panel.
- **BYOK, and only BYOK:** the user supplies their own API key for **Anthropic, OpenAI, or Google
  AI**, stored in VS Code `SecretStorage`. The extension calls that provider directly. There is
  **no account, no sign-in, and no server** — see §2 D1.
- **Provider and model are the user's choice**, not the extension's: the provider follows from the
  key, and the model is discovered from the provider rather than hardcoded (D2, D9).

**Non-goals for v1:** a cloud proxy or any hosted backend, prompt libraries/history, workspace-wide
context gathering, team/org accounts, telemetry.

---

## 2. Locked decisions

Settled. Changing one is a design change, not an implementation choice.

| # | Decision | Rationale |
|---|---|---|
| D1 | **BYOK only in v1. No backend at all.** | A proxy on the author's API key needs some notion of who is calling, or it is an open endpoint billing the author for strangers. Everything that machinery cost — anonymous auth, per-caller quota, spend caps, kill switch, a Firebase project, two build phases — bought one thing: a user with no key. That user is better served by `vscode.lm` (D6) than by a bill. Cut. |
| D2 | **Three providers in v1: Anthropic, OpenAI, and Google AI**, each an adapter behind one `ModelClient` interface (§6). | The task is the simplest thing an LLM does — system prompt plus user text in, text out — so no provider has a structural advantage and the adapter surface is genuinely small. Earlier revisions pinned one provider (Gemini in rev 1 because the cut backend was Genkit; Anthropic in rev 3); with BYOK and no server, that constraint bought nothing the user wanted. The real cost is eval surface, not code — see D10. |
| D3 | **The prompt template is a single authored file** in a shared workspace package. | Consumed by the extension and by the eval runner (§10), and it keeps the prompt independently testable. Prompt text never lives in TypeScript. |
| D6 | **`vscode.lm` (Copilot-backed) is the v2 answer for users without a key.** | Zero cost to the author, no auth, no abuse surface — strictly better than a proxy. Requires the user to have a chat model provider, which is why it is not the v1 default. |
| D7 | **Keybinding default is `ctrl+alt+e` / `cmd+alt+e`**, gated on `editorHasSelection`. | `ctrl+shift+e` is Focus Explorer on every platform and must not be overridden. |
| D8 | **Editor path is non-streaming; chat path streams plain text.** | Validated output and token streaming are mutually exclusive. Each flow gets the one that fits. |
| D9 | **Model IDs are discovered at runtime, never hardcoded.** Each adapter exposes a `listModels()` and the extension picks from it; a `promptEnhancer.model` setting overrides. | Provider model IDs churn faster than extension releases — OpenAI's and Google's both moved more than once during this document's life. A hardcoded default is a guaranteed future support ticket. Discovery reuses the models-list call that key validation already needs, so it costs one request, not a new mechanism. |
| D10 | **The prompt template is tuned and evaluated against one primary provider; the others are supported, not guaranteed identical.** | One template across three models means it is tuned for whichever was tested. The §10 structural criteria are generic enough to mostly transfer, but "mostly" is doing real work — so goldens record which provider and model produced them, and a provider that fails the regression rule is documented, not silently shipped. |

D4 and D5 covered the proxy's prompt-relay defence and its anonymous-auth identity. Both are
withdrawn with the proxy; the numbering is left with gaps so older commits and reviews still
reference the right decisions.

**On sign-in generally:** no version of this extension has ever required a user to log in. The
withdrawn anonymous auth was invisible per-install attribution for the proxy's quota, not a
sign-in screen. With the proxy gone the question is moot — the user pastes a key and that is the
entire setup.

---

## 3. Repository layout

A pnpm workspace on `github.com/Geoffrey-Zulu/prompt-enhancer` (see §13 for the branch layout).

```
prompt-enhancer/
├── extension/              # the VS Code extension (the publishable artifact)
│   ├── src/
│   │   ├── extension.ts        # activate/deactivate, registration only
│   │   ├── commands/           # enhanceSelection, setApiKey, clearApiKey
│   │   ├── chat/               # @enhance participant handler
│   │   ├── providers/
│   │   │   ├── types.ts            # ModelClient, ProviderId, ModelError
│   │   │   ├── registry.ts         # key-prefix detection, adapter construction
│   │   │   ├── anthropic.ts        # one adapter per provider, no shared branching
│   │   │   ├── openai.ts
│   │   │   └── google.ts
│   │   ├── services/
│   │   │   └── SecretService.ts    # wraps context.secrets, one key per provider
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
  host-injected and must never be bundled; the workspace prompts package and the provider SDKs are
  bundled in, since a `.vsix` has no `node_modules`.
- **Runtime dependencies:** the three official SDKs — `@anthropic-ai/sdk`, `openai`, and Google's
  Gen AI SDK — and nothing else. Each handles auth headers, streaming SSE parsing, retries, and
  typed errors; hand-rolling that three times against three moving APIs is the larger risk.
- **Bundle size is a real cost of D2**, and the measurement is in: **the `.vsix` is 451 KB** from a
  2.6 MB bundle (Phase 3, all three SDKs, sourcemap excluded from the package). Composition:

  | Part | Bundled |
  |---|---|
  | `@google/genai` + its transitive deps (`google-auth-library`, `web-streams-polyfill`, `ws`, `node-fetch`, `gaxios`, …) | ~1 600 KB |
  | `@anthropic-ai/sdk` | 447 KB |
  | `openai` | 410 KB |
  | this extension + the prompts package | 48 KB |

  The Google SDK is ~3.5× the Anthropic one, almost entirely in code this extension never calls:
  Vertex AI service-account auth and the Live API's WebSocket stack. **No action taken** — 451 KB is
  unremarkable for a Marketplace extension, and esbuild already wraps each module in a lazy
  initialiser, so an unused SDK is parsed but never executed. If it ever does matter, the mitigation
  stays the one named here: lazy `require()` per adapter, not dropping a provider.
- **Secrets:** VS Code `SecretStorage` only (§7).

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

This package owns prompt text and nothing else. **Provider and model configuration deliberately do
not live here** — they are not a prompt concern, and putting them here would make the eval runner
and the extension disagree about who chooses a model. The registry lives in
`extension/src/providers/`, and the eval runner takes `--provider` / `--model` flags.

- Both entry points — the editor command and the chat participant — call `renderEnhancePrompt`.
  The eval runner (§10) is the third consumer and the reason the sha256 is worth recording: a
  golden run is reported against the exact template bytes it tested.
- Changing the template in a way that alters behaviour means bumping `TEMPLATE_VERSION`
  (`enhance.v2`) and re-running the goldens. With no server there is no version negotiation — the
  template and the code that uses it ship together in one `.vsix`.
- `ENHANCE_MODES` is a closed enum. Unknown values are rejected before any network call.

---

## 6. Providers and the model call

### The interface

Exactly one abstraction, and every adapter implements it fully. Callers never branch on provider.

```ts
export type ProviderId = 'anthropic' | 'openai' | 'google';

export interface ModelInfo { id: string; label: string }

export interface ModelClient {
  readonly provider: ProviderId;

  /** Model IDs this key can actually use (D9). Also serves as key validation. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;

  /** Non-streaming: the editor path. Resolves to the finished prompt text. */
  enhance(p: RenderedPrompt, model: string, signal?: AbortSignal): Promise<string>;

  /** Streaming: the chat path. Yields text deltas only. */
  enhanceStream(p: RenderedPrompt, model: string, signal?: AbortSignal): AsyncIterable<string>;
}
```

**Adapters normalise; they do not leak.** Each adapter turns its provider's wire format, finish
reasons, and error types into the shapes above plus the common `ModelError` (section 9). If a
provider concept has no equivalent in the interface, handling it is the adapter's job, not the
caller's job to know about. A `switch (provider)` anywhere outside `providers/registry.ts` is a
design failure.

### Which provider

Guessed from the key prefix, in `registry.ts`:

| Prefix | Provider |
|---|---|
| `sk-ant-` | Anthropic |
| `AQ.` | Google AI — the authorization-key format AI Studio issues now |
| `AIza` | Google AI — the older standard-key format, being retired |
| `sk-` (anything else beginning `sk-`) | OpenAI |

**Order matters, and it is the one real trap here:** Anthropic keys also begin `sk-`, so `sk-ant-`
must be tested **first**. Getting this backwards sends every Anthropic key to the OpenAI adapter,
where it fails as a confusing 401 rather than an obvious bug. There is a unit test for exactly this.

**Prefix detection is a fast path, not a gate** — revised after the original design got this wrong.
It read: *an unrecognised prefix is rejected at key-set time with "That doesn't look like a supported
API key" rather than stored and left to fail later.* That rejected a working key. Google replaced its
entire key format during this project's life: AI Studio now issues `AQ.` authorization keys and is
retiring `AIza`, so a table containing only `AIza` refuses every Google key created today.

The lesson is the one D9 already draws about model IDs — **a table of provider-specific strings is
exactly as durable as a hardcoded model ID, and key prefixes churn for the same reasons.** So:

- a recognised prefix routes the key with no questions asked;
- an **unrecognised** prefix asks the user which provider it belongs to, saying that the format is
  unfamiliar rather than implying the key is wrong;
- input that is not key-shaped at all — too short, containing whitespace, or a URL, which is a real
  mis-paste — is refused without asking.

The guarantee the original rule was protecting is untouched, because it never depended on the prefix:
**a key is validated against its provider with one `listModels()` call before it is stored** (§7). An
invalid key is still never stored, whatever its shape.

This also means the extension can hold a key whose shape the log's redaction patterns do not know, so
§9.3 gains a pattern that strips a long opaque token next to a label saying what it is.

### Which model (D9)

No model ID is hardcoded. Resolution order, per provider:

1. The `promptEnhancer.model` setting, if set and non-empty. This is the escape hatch that lets a
   brand-new model work without an extension release, and it is why no ID needs to ship at all.
2. Otherwise the model chosen at key-set time and stored per provider, picked from `listModels()`.
3. If neither exists, a quick-pick from `listModels()` on first use.

The setting is validated on use, not on write, so typos surface as "Model `x` is not available on
your `<provider>` key" with a Change Model action instead of being silently swallowed.

**Command:** "Prompt Enhancer: Select Model" re-runs the quick-pick against the active key, so
changing model never requires hand-editing settings.

### The request

Common to every adapter:

- **System text goes in the provider's system slot** - Anthropic's top-level `system`, an OpenAI
  system/developer message, Gemini's `systemInstruction`. Never concatenated into the user text.
- **No sampling parameters on any provider.** No `temperature`, `top_p`, or `top_k`, anywhere. This
  is not stylistic: `claude-opus-5` rejects them with a 400, and several reasoning models on the
  other providers restrict them too. Omitting them is the only choice that is correct everywhere,
  and the template's instructions steer output shape instead.
- **A generous output budget.** Where a provider's cap also covers internal reasoning tokens, size
  it for reasoning **plus** the answer, not tight around the answer.
- **`AbortSignal` threaded through to the underlying request**, so cancellation is real rather than
  cosmetic.
- **Prompt caching where the provider offers it**, on the system block only. The rendered system text
  is byte-identical across enhancements in the same mode, so it caches well - and nothing volatile
  may ever be interpolated into it, or caching silently stops.

### Reading the response

Three rules, each of which exists because of a real failure mode:

1. **Never assume the first content block is the answer.** On reasoning-capable models the first
   block is often internal reasoning. Adapters must select text parts explicitly and join them, not
   index position zero. This was a live bug in rev 3 of this document.
2. **Never let internal reasoning reach the output.** Some models emit reasoning markup into the
   visible response when reasoning is disabled. Adapters must leave reasoning enabled where that is
   the safe setting, and must never return text they have not confirmed is answer content - on the
   editor path this goes straight into the user's file.
3. **Check the finish reason before using the content.** A truncated or declined response is a
   failure, never something written over the selection.

**Input caps** (enforced before any call, provider-independent): `rough_text` 1-20 000 chars,
`context` <= 2 000 chars. This is what stops a whole-file selection from becoming a surprise bill on
the user's key.

**Streaming** - `enhanceStream` yields text deltas only. Each adapter filters its provider's
non-text events out of the stream and checks the terminal finish reason before the consumer treats
the result as complete.

---

## 7. API key handling

The whole of the extension's security surface, now that there is no server.

- **One key per provider, stored separately:** `promptEnhancer.apiKey.anthropic`,
  `promptEnhancer.apiKey.openai`, `promptEnhancer.apiKey.google`. A user with several keys keeps
  them all, and switching provider does not mean re-pasting.
- **Store via `context.secrets.store(...)` only.** Keys must **never** touch
  `workspace.configuration`, workspace state, `globalState`, logs, or error messages. Settings sync
  and workspace files are the two places a key must not end up - which is also why
  `promptEnhancer.model` can be a setting and the key never can.
- **Retrieve** with `context.secrets.get(...)`, read per call, never cached in a module-level
  variable. Provider clients are constructed per call from that key - never at module scope, and
  never from `process.env`, so a key in the developer's environment cannot silently stand in for the
  user's.
- **Active provider:** with one key stored, that is the provider. With several, the
  `promptEnhancer.provider` setting selects; absent that, prompt once and remember.
- **Commands:** "Set API Key" (`showInputBox` with `password: true`, provider inferred from the
  prefix), "Clear API Key" (quick-pick which provider, or all), and "Select Model".
- **Validate on set:** one `listModels()` call. It confirms the key works *and* populates the model
  quick-pick in the same request. Never store an invalid key silently.
- **Rotation:** setting a key overwrites that provider's key only. Clearing removes it, and the
  extension prompts on next use rather than failing obscurely.
- **Redaction:** all logging goes through a single channel that strips every supported key shape
  (`sk-ant-...`, `sk-...`, `AIza...`) and bearer tokens at the boundary, so forgetting to redact at a
  call site is not possible (section 9.3). Adding a provider means adding its key pattern here, and
  a test asserts every supported prefix is redacted.

---

## 8. Workflows

### Flow A — Editor enhancement (in-place)

1. **Trigger:** user selects text, presses `ctrl+alt+e` (`cmd+alt+e` on macOS). The keybinding's
   `when` clause is `editorTextFocus && editorHasSelection`.
2. **Capture:** read `activeTextEditor.selection`; capture `document.languageId`, the selection
   range, and `document.version`. Empty or whitespace-only selection → info message, no call.
3. **Validate:** length caps and mode resolution per §5/§6.
4. **Client:** resolve provider + model per §6/§7. No key at all → the "Set API Key" prompt, and
   stop. Key but no model resolved → the model quick-pick, then continue.
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
4. **Client:** same §6/§7 resolution. A missing key is reported in the chat stream with the same
   action; the active provider and model are named in the response header so the user always
   knows which model answered.
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
4. **Mapped messages.** Each adapter translates its provider's failures into one common
   `ModelError` with a `kind`, and the UI maps `kind` to a message and an action. This is the only
   way three providers stay presentable without the UI knowing three error taxonomies.

| `ModelError.kind` | Message | Action |
|---|---|---|
| `auth` | "That API key was rejected - check it or set a new one." | Set API Key |
| `forbidden` | "The key is valid but not permitted to use `<model>`." | Select Model |
| `model_not_found` | "Model `<model>` is not available on your `<provider>` key." | Select Model |
| `rate_limit` | "Rate limit reached - wait a moment and retry." | Retry |
| `server` | "`<provider>` is unavailable right now." | Retry |
| `offline` | "Can't reach `<provider>` - check your connection." | - |
| `truncated` | "The result was truncated - try a smaller selection." | - |
| `declined` | "The model declined to process this text." | - |
| `bad_request` | "The request was rejected." (details to the log - this is our bug, not the user's) | Open Output |
| `no_key` | "Add an API key to use Prompt Enhancer." | Set API Key |

   Every message names the provider or model where one is relevant. With three providers in play,
   "rate limit reached" without saying whose is a support question waiting to happen.

   Each adapter maps by its SDK's **typed error classes**, never by matching message strings. Where
   an SDK already retries 429 and 5xx internally, do not wrap a second retry layer around it - an
   error reaching this table means retries are exhausted.

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
- The runner reports pass rate against `TEMPLATE_SHA256` **and the provider + model it ran**, so a
  result is traceable to exact template bytes and an exact model. Any `TEMPLATE_VERSION` bump
  requires a run on the primary provider, recorded in the PR.
- **Per D10, a template change must not be judged on one provider alone before release.** Run the
  goldens on all three at least once per release and record the three pass rates. Where a
  provider scores materially worse, say so in the README rather than implying parity.
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

**Phase 2 — One provider end to end**
The `ModelClient` interface and `ModelError` (§6), the registry with key-prefix detection,
`SecretService`, the key and model commands with live validation, **one** adapter, and Flow A wired
to the editor including every §9 rule and the Flow A.6 document-version guard. First shippable
version.

Build one adapter, not three. The interface only earns trust once a second implementation lands, and
designing speculatively for three providers before any of them works is how abstractions go wrong in
both directions. **Expect the interface to change in Phase 3** — that is cheaper than guessing now.
Keep provider specifics inside the adapter so the change stays local when it comes.

**Phase 3 — The other two providers**
The remaining two adapters, the model quick-pick and `promptEnhancer.provider` / `.model` settings,
per-provider key storage, and the redaction test covering all three key shapes. Refactor the
interface here if the new adapters expose a bad assumption. Ends with the `.vsix` size measured and
recorded (§4).

**Phase 4 — Chat participant**
Flow B, streaming, slash-command modes, follow-ups, cancellation.

**Phase 5 — Evals, tests, packaging**
Golden set and runner with `--provider` / `--model` flags, all-three-provider run per D10,
`@vscode/test-electron` suite, CI, `vsce` packaging, README with the §13 privacy disclosure.

Phase numbering has moved twice. Rev 2 withdrew the Firebase backend and proxy client (then Phases 4
and 5) to v2 and renumbered packaging from 6 to 4. Rev 4 inserts the second-and-third-provider work
as Phase 3, pushing chat to 4 and packaging to 5. Older commit messages and reviews will not match.

**Contribution rule (applies to every phase):** a `package.json` contribution lands in the same
phase as its implementation. Declaring `chatParticipants` before Flow B exists would put a broken
`@enhance` in the chat panel, and declaring the key commands early would put dead entries in the
command palette. So `promptEnhancer.setApiKey` / `clearApiKey` arrive in Phase 2 and
`chatParticipants` in Phase 3.

---

## 12. Testing

- **Unit** (vitest): `renderEnhancePrompt` determinism, mode validation, length caps, and per
  adapter - error mapping to `ModelError.kind`, response-shape handling from §6, and stream-delta
  filtering. Plus two that exist because they are easy to get wrong:
  - **key-prefix detection**, asserting `sk-ant-...` resolves to Anthropic and not OpenAI;
  - **redaction**, asserting every supported key shape is stripped from log output.
- **Integration** (`@vscode/test-electron`): command registration, selection replace as a single
  undo step, document-changed-during-request guard, cancellation leaves the buffer untouched, chat
  participant resolves and streams, no-key path shows the action.
- **Evals:** the §10 golden runner, run deliberately on template changes.
- **Manual smoke before release, per provider:** valid key, invalid key, no key, a model the key
  can't use, offline, an oversized selection, and a selection edited mid-request. Three providers
  makes this the longest manual pass in the project - automate what §12's integration suite can
  cover and keep the list honest about what it can't.

No backend means no emulator and no deploy testing. Adapter tests stub the provider SDK; only the
golden runner and the manual pass spend real tokens.

---

## 13. Branching, CI, and publishing

- **Remote:** `github.com/Geoffrey-Zulu/prompt-enhancer` (private).
- **Branching — three tiers, and `dev` is the one you work from:**
  - **`main` holds production-ready code only.** It advances from `dev` at a release, never from a
    feature branch, and is never pushed to directly. Until Phase 5 packages a `.vsix` there is
    nothing production-ready to put on it, so it deliberately sits behind `dev`.
  - **`dev` is the integration line and the repository's default branch**, so pull requests target
    it without anyone having to remember to change the base.
  - **`feature/*` and `fix/*` always branch from `dev`** and land back in `dev` via pull request.
    Branching a feature from `main` would build on a release, not on the current state.
  - A release is therefore one `dev` → `main` pull request, not a cherry-pick.
- **Commits:** conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- **CI (Phase 5):** lint, typecheck, unit + integration tests on every pull request into `dev` and
  `main`; `vsce package` artifact on `main` only, since that is the branch a release comes from. The
  eval runner is not in CI — it needs a real key.
- **Publishing:** VS Code Marketplace via `vsce`. Requires a publisher ID and a PAT — an external
  step for the repo owner.
- **Privacy disclosure (required in the README and the Marketplace listing):** the text you select
  is sent to **whichever provider your API key belongs to** - Anthropic, OpenAI, or Google - and
  nowhere else. The extension has no server, collects no telemetry, and the author never sees your
  text or your key. Keys are held in the OS credential store via VS Code `SecretStorage`. Name all
  three providers explicitly and state that the choice follows from the key you supply; a user who
  can only send data to one vendor needs to be able to tell that from the listing.

That disclosure staying short is the clearest measure of what cutting the proxy bought - adding two
providers cost it one clause, not a paragraph of caveats.

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
- **Further providers** (Azure OpenAI, Bedrock, OpenRouter, a local Ollama endpoint) - each is one
  more `ModelClient` adapter once the interface has survived three implementations.
- **Per-mode model selection** - a cheap fast model for `code`, a stronger one for `architecture`.
  Deferred because it needs the D10 eval data to choose sensibly.
- Prompt history and a saved-prompt library; workspace-aware context beyond `languageId`; team/org
  key management; usage telemetry.
