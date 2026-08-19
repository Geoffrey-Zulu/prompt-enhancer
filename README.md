# Prompt Enhancer

A VS Code extension that turns rough notes into structured, context-rich prompts — in the editor
or in the chat panel.

Design and build order live in [tdd.md](tdd.md); current state and what to do next are in
[tasks.md](tasks.md). **Phases 1 and 2 are complete**: with an Anthropic key set, the keybinding
replaces the selection with a structured prompt. The other two providers arrive in Phase 3 and the
chat participant in Phase 4.

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

**Today only the Anthropic adapter exists** (Phase 2 deliberately ships one, per TDD §11). An OpenAI
or Google key is recognised but refused at key-set time with a message saying so, rather than being
stored and left to fail later.

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

The extension's unit suite covers what must be right before an editor is involved: key-prefix
detection, the request body actually sent to the provider, response and stop-reason handling, input
caps, and key redaction. It aliases the host-injected `vscode` module to a stub; the editor
behaviour itself needs the `@vscode/test-electron` suite, which arrives in Phase 5 (TDD §12).

## Run the extension

Press <kbd>F5</kbd> (the **Run Extension** launch config) to open an Extension Development Host.
In that window:

1. Run **Prompt Enhancer: Set API Key** and paste an Anthropic key. It is validated with one
   models-list call before it is stored, and the same call populates the model quick-pick.
2. Select some rough text in any file and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>
   (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> on macOS), or use **Prompt Enhancer: Enhance
   Selection** from the command palette.

The selection is replaced in place, as a single undo step. If the request fails, is cancelled, or
the document changed while it was running, the buffer is left exactly as it was — see TDD §9.1.
**Prompt Enhancer: Select Model** changes the model and **Clear API Key** removes a key.
Diagnostics go to the **Prompt Enhancer** output channel, which redacts every supported key shape.

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
