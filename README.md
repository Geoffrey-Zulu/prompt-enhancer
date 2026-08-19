# Prompt Enhancer

A VS Code extension that turns rough notes into structured, context-rich prompts — in the editor
or in the chat panel.

Design and build order live in [tdd.md](tdd.md); current state and what to do next are in
[tasks.md](tasks.md). **Phases 1–4 are complete**: set a key for any of the three providers and
either press the keybinding to rewrite a selection in place, or ask `@enhance` in the chat panel.
Phase 5 is evals, integration tests, and packaging.

> The user-facing README, including the privacy disclosure required for the Marketplace listing,
> is written in Phase 5. This file is developer setup only.

## Layout

| Path | What it is |
|---|---|
| `extension/` | the VS Code extension — the publishable artifact |
| `packages/prompts/` | the enhancement prompt, single source of truth (TDD D3) |
| `evals/` | golden set for the §10 quality bar (Phase 5) |

The extension is BYOK-only and provider-agnostic by design: supply an **Anthropic, OpenAI, or
Google AI** key and it calls that provider directly. The provider follows from the key's prefix, and
the model is discovered from the provider rather than hardcoded — so a newly released model works
without an extension update. There is no backend, no account, and no sign-in. See TDD D1 for why the
cloud proxy was cut, D2 for the provider set, and D9 for model discovery.

All three adapters exist as of Phase 3. Keys are stored per provider, so several can be held at once;
with more than one stored, `promptEnhancer.provider` picks between them and otherwise you are asked
once and the answer remembered.

**Only the Anthropic path has been exercised against a live API.** Every rule each adapter must
follow is unit-tested against a stubbed `fetch` — which proves what goes on the wire and how the
response is read, not that the provider returns 200. See "Open from Phase 3" in
[tasks.md](tasks.md).

## Setup

Requires Node 20+ and pnpm 9.

```bash
pnpm install
```

## Build, typecheck, test

```bash
pnpm build
```

```bash
pnpm -r typecheck
```

```bash
pnpm --filter @prompt-enhancer/prompts test
```

```bash
pnpm --filter prompt-enhancer test
```

The extension's unit suite (119 tests) covers what must be right before an editor is involved:
key-prefix detection, the request body actually sent to each provider, response and finish-reason
handling, input caps, and key redaction. It aliases the host-injected `vscode` module to a stub; the
editor behaviour itself needs the `@vscode/test-electron` suite, which arrives in Phase 5 (TDD §12).

The `*.request.test.ts` suites replace global `fetch` and assert the real outgoing request — no
sampling parameters, the system text in the provider's own system slot, reasoning left enabled, and
reasoning never read back as answer text. Those rules are invisible when reading a call site, so they
are asserted against the wire rather than reviewed.

One suite is opt-in because it spends real tokens: `live.test.ts` runs the adapters against the real
APIs and is Phase 3's acceptance criterion made runnable. It needs a key per provider and an explicit
flag, so a key sitting in your shell for another reason cannot turn `pnpm test` into a bill:

```bash
PROMPT_ENHANCER_LIVE=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GOOGLE_API_KEY=...   pnpm --filter prompt-enhancer test:live
```

It names any provider it could not cover and fails on a partial run.

## Run the extension

Press <kbd>F5</kbd> (the **Run Extension** launch config) to open an Extension Development Host.
In that window:

1. Run **Prompt Enhancer: Set API Key** and paste an Anthropic, OpenAI, or Google AI key — the
   provider follows from the key's prefix. It is validated with one models-list call before it is
   stored, and the same call populates the model quick-pick.
2. Select some rough text in any file and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>
   (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> on macOS), or use **Prompt Enhancer: Enhance
   Selection** from the command palette.

The selection is replaced in place, as a single undo step. If the request fails, is cancelled, or
the document changed while it was running, the buffer is left exactly as it was — see TDD §9.1.
**Prompt Enhancer: Select Model** changes the model and **Clear API Key** removes a key.
Diagnostics go to the **Prompt Enhancer** output channel, which redacts every supported key shape.

In the chat panel, `@enhance <rough note>` streams the prompt instead, with `/code`,
`/architecture`, and `/refactor` choosing the mode (`code` is the default). The response names the
provider and model that answered, and ends with **Insert into editor** and **Copy** buttons.

## Editing the prompt

`packages/prompts/templates/enhance.v1.md` is the only place prompt text is authored. It is
inlined into `src/generated/template.ts` at build time (not committed). Changing it in a way that
alters behaviour means bumping `TEMPLATE_VERSION` — see TDD §5.

## Branching

Three tiers, and `dev` is the one you work from — see tdd.md §13 for the reasoning.

| Branch | What it holds |
|---|---|
| `main` | production-ready code only; advances from `dev` at a release, never from a feature branch |
| `dev` | the integration line, and the repository's default branch so PRs target it automatically |
| `feature/*`, `fix/*` | always branched **from `dev`**, and merged back into `dev` via pull request |

```bash
git checkout dev && git pull && git checkout -b feature/my-thing
```

`main` currently sits behind `dev` on purpose: nothing is production-ready until Phase 5 packages a
`.vsix`.
