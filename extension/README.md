# Prompt Enhancer

Turn rough notes into structured prompts — in the editor, or in the chat panel.

Select the half-formed thought you would have sent anyway, press
<kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd>, and it is replaced in place with a prompt that states a
role, a task, the relevant context, the constraints, and the output format you want back.

```
fix the NullPointerException in UserRepo.findById(id) at line 42
```

becomes a prompt that asks for that fix without the assistant having to guess your framework, your
test runner, or whether it is allowed to change the method signature — because it is told not to
invent any of them.

## Bring your own key

There is no account, no sign-in, and no server. You supply an API key for **Anthropic, OpenAI, or
Google AI**, and the extension talks to that provider directly.

1. Run **Prompt Enhancer: Set API Key** from the command palette.
2. Paste your key. The provider is worked out from the key itself — you do not pick one.
3. Choose a model from the list your key can actually use.

Keys are held in your operating system's credential store, through VS Code's `SecretStorage`. One key
per provider, so you can keep several and switch without re-pasting.

## Privacy

**The text you select is sent to whichever provider your API key belongs to — Anthropic, OpenAI, or
Google AI — and nowhere else.** Which one that is follows entirely from the key you supply; if you
only ever set an Anthropic key, your text only ever goes to Anthropic.

- The extension has **no server**. Nothing is proxied through the author.
- It collects **no telemetry** of any kind.
- The author never sees your text or your key.
- Your key is stored in the OS credential store via VS Code `SecretStorage`. It is never written to
  your settings, your workspace, or a log — the extension's log output strips every supported key
  shape unconditionally.
- On OpenAI, requests are sent with `store: false`, so your text is not retained in your OpenAI
  account after the response.

The only network requests the extension makes are to your provider: one to list the models your key
can use, and one per enhancement.

## Using it

### In the editor

| Action | How |
|---|---|
| Enhance the selection | <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> (<kbd>Cmd</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> on macOS), or the editor context menu |
| Change model | **Prompt Enhancer: Select Model** |
| Remove a key | **Prompt Enhancer: Clear API Key** |

The replacement is a **single undo step** — one <kbd>Ctrl</kbd>+<kbd>Z</kbd> puts your original text
back. If the request fails, you cancel it, or you edit the document while it is running, your buffer
is left exactly as it was and the result opens in a separate tab instead.

### In the chat panel

```
@enhance the login form should validate the email before submitting
@enhance /architecture should the nightly report move to a queue or stay a cron job
@enhance /refactor handleRequest() is 400 lines and does three unrelated things
```

Three modes, chosen with a slash command:

- **`/code`** (the default) — pushes for working code: the function to change, the behaviour expected
  afterwards, the error handling, and how to verify it.
- **`/architecture`** — pushes for a design rather than an implementation: the forces in play, the
  alternatives, the non-functional requirements, and the decision to be made. Explicitly asks for no
  implementation code.
- **`/refactor`** — pushes for a behaviour-preserving change, and requires the response to call out
  anywhere behaviour could shift.

The response names the provider and model that answered, and offers **Insert into editor** and
**Copy** when it finishes.

## Settings

| Setting | What it does |
|---|---|
| `promptEnhancer.model` | Use a specific model, overriding the one you picked. Useful for a model released after this extension was. |
| `promptEnhancer.provider` | Which provider to use when you have more than one key stored. Ignored when you only have one. |

No model IDs are built into this extension. They are discovered from your provider at runtime, so a
newly released model works without waiting for an update.

## Limits

- A selection must be between 1 and 20,000 characters. This is what stops a whole-file selection
  becoming a surprise charge on your key.
- Requests time out after 30 seconds and can be cancelled at any point.
- The prompt template is tuned and evaluated primarily against Anthropic. The other two providers are
  supported and use the same template, but their output is not guaranteed to be identical in quality.

## Known gaps

Being straight about what has and has not been exercised against a live API:

- The **Anthropic** path is the primary one and the template is tuned for it.
- The **OpenAI** and **Google AI** adapters are complete and unit-tested against their SDKs, but have
  not yet been run against the live APIs. If you hit something, please open an issue — it is more
  likely to be an untested assumption than a deep problem.

## Requirements

VS Code 1.90 or later. An API key from one of the three supported providers.
