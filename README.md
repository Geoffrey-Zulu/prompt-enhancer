# Prompt Enhancer

A VS Code extension that turns rough notes into structured, context-rich prompts — in the editor
or in the chat panel.

Design and build order live in [tdd.md](tdd.md); current state and what to do next are in
[tasks.md](tasks.md). **Phase 1 (repo & scaffold) is complete**; the first working model call arrives
in Phase 2.

> The user-facing README, including the privacy disclosure required for the Marketplace listing,
> is written in Phase 5. This file is developer setup only.

## Layout

| Path | What it is |
|---|---|
| `extension/` | the VS Code extension — the publishable artifact |
| `packages/prompts/` | the enhancement prompt, single source of truth (TDD D3) |
| `evals/` | golden set for the §10 quality bar (Phase 5) |

The extension is BYOK-only and provider-agnostic: supply an **Anthropic, OpenAI, or Google AI** key
and it calls that provider directly. The provider follows from the key's prefix, and the model is
discovered from the provider rather than hardcoded — so a newly released model works without an
extension update. There is no backend, no account, and no sign-in. See TDD D1 for why the cloud proxy
was cut, D2 for the provider set, and D9 for model discovery.

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

## Run the extension

Press <kbd>F5</kbd> (the **Run Extension** launch config) to open an Extension Development Host.
Then select some text in any file and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>
(<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> on macOS), or use **Prompt Enhancer: Enhance
Selection** from the command palette.

In Phase 1 this renders the prompt and opens it in a preview document beside the editor — no model
is called yet. Diagnostics go to the **Prompt Enhancer** output channel.

## Editing the prompt

`packages/prompts/templates/enhance.v1.md` is the only place prompt text is authored. It is
inlined into `src/generated/template.ts` at build time (not committed). Changing it in a way that
alters behaviour means bumping `TEMPLATE_VERSION` — see TDD §5.

## Branching

`main` is always releasable. Work happens on `feature/*` or `fix/*` and lands via pull request;
nothing is pushed directly to `main`. No remote is configured yet.
