# Prompt Enhancer

Turn a rough thought into a prompt worth sending.

You know the one you were about to type:

> *I want you to fix the landing page, make it so so good*

Prompt Enhancer rewrites that into a prompt that states a role, the task, the relevant context, the
constraints, and the output format you want back- then puts it on your clipboard so you can paste it
into whichever AI you actually use.

It **invents nothing**. If you didn't say which framework, it won't pick one; it lists what's
unspecified so you can fill it in.

## Works with any chat

Claude Code, ChatGPT, Copilot, Gemini, anything. The result goes to your clipboard and you paste it.

That's deliberate, and it's a platform limit worth being straight about: **no VS Code extension can
read or edit the text inside another extension's chat box.** Those panels are private to the extension
that owns them. So "select what you typed in the chat and press a key" isn't something this- or any-
extension can do. The clipboard is the one bridge that works everywhere.

## Bring your own key

No account, no sign-in, no server. You supply an API key for **Anthropic, OpenAI, or Google AI**, and
the extension talks to that provider directly.

1. **Prompt Enhancer: Set API Key** from the command palette.
2. Paste your key. The provider is worked out from the key- and if the format is unfamiliar, you're
   asked rather than refused.
3. Pick a model from the list your key can actually use.

Keys live in your operating system's credential store, via VS Code's `SecretStorage`. One key per
provider, so you can keep several and switch without re-pasting.

## Three ways in

### The panel

Click the Prompt Enhancer icon in the activity bar. Type or paste your rough prompt, pick a mode, hit
**Enhance**. The result streams in as it's written, stays editable, and is copied to your clipboard
when it finishes. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> in the input runs it.

Use this when you want to see the result, tweak it, or try a different mode.

### The shortcut

<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> on macOS)
anywhere- including with a chat panel focused. Type the rough prompt, press Enter, and the enhanced
version is on your clipboard and open in a tab.

Use this when you're mid-flow and just want the text.

### Rewriting a prompt that lives in a file

Select prompt text in a file and run **Prompt Enhancer: Enhance Selection** from the context menu or
the palette. It's replaced in place, as a single undo step.

This is for files that contain prompts- `CLAUDE.md`, `.github/copilot-instructions.md`, a system
prompt in your source, a scratch note. It is **not** for enhancing code: pointing it at a `.tsx` file
will faithfully rewrite your component as a prompt, which is not useful to anyone.

If the request fails, you cancel it, or you edit the document while it's running, your buffer is left
exactly as it was and the result opens in a separate tab instead.

## Modes

| Mode | Pushes for |
|---|---|
| **code** (default) | The function to change, the behaviour expected afterwards, the error handling, how to verify it |
| **architecture** | The problem, the forces, the alternatives, the non-functional requirements, the decision to be made- and explicitly no implementation code |
| **refactor** | A behaviour-preserving change, with the response required to call out anywhere behaviour could shift |

## Privacy

**The text you send is sent to whichever provider your API key belongs to- Anthropic, OpenAI, or
Google AI- and nowhere else.** Which one follows entirely from the key you supply; set only an
Anthropic key and your text only ever goes to Anthropic.

- The extension has **no server**. Nothing is proxied through the author.
- It collects **no telemetry** of any kind.
- The author never sees your text or your key.
- Your key is stored in the OS credential store via VS Code `SecretStorage`. It is never written to
  your settings, your workspace, or a log- the log output strips key shapes unconditionally.
- On OpenAI, requests are sent with `store: false`, so your text isn't retained in your OpenAI account
  after the response.

The only network requests made are to your provider: one to list the models your key can use, and one
per enhancement.

## Settings

| Setting | What it does |
|---|---|
| `promptEnhancer.defaultMode` | Mode used by the shortcut and the editor command. The panel has its own picker. |
| `promptEnhancer.model` | Use a specific model, overriding the one you picked. Useful for a model released after this extension was. |
| `promptEnhancer.provider` | Which provider to use when you have more than one key stored. Ignored when you only have one. |

No model IDs are built into this extension. They're discovered from your provider at runtime, so a
newly released model works without waiting for an update.

## Limits

- A prompt must be between 1 and 20,000 characters. That's what stops a whole-file paste becoming a
  surprise charge on your key.
- Requests time out after 30 seconds and can be cancelled at any point.
- The prompt template is tuned primarily against Anthropic. The other two providers use the same
  template and are supported, but their output isn't guaranteed to be identical in quality.

## Known gaps

Being straight about what has and hasn't been exercised against a live API:

- The **Anthropic** path is the primary one and the template is tuned for it.
- The **OpenAI** and **Google AI** adapters are complete and unit-tested against their SDKs, but have
  not yet been run against the live APIs. If you hit something, please open an issue- it's more
  likely to be an untested assumption than a deep problem.

## Requirements

VS Code 1.90 or later, and an API key from one of the three supported providers.
