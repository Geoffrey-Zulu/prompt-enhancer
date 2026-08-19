# Changelog

## 0.1.0

First public release.

### Added

- **Panel.** A Prompt Enhancer view in the activity bar: paste a rough prompt, pick a mode, watch
  the result stream in, edit it. It is on your clipboard when it finishes. Set your API key, change
  model and clear your key from the panel itself.
- **Shortcut.** <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>E</kbd> anywhere, including with a chat panel
  focused. Type the rough prompt, press Enter, paste the result wherever you were going.
- **Editor rewrite.** Select prompt text in a file and rewrite it in place, as a single undo step.
  For files that contain prompts, such as `CLAUDE.md` or an instructions file.
- **Three providers.** Anthropic, OpenAI and Google AI, chosen by the key you supply. Keys live in
  the OS credential store, one per provider. Models are discovered from your provider at runtime,
  so nothing is hardcoded and a new model works without an update.
- **Three modes.** `code`, `architecture` and `refactor`.

### Known gaps

- The prompt template is tuned against Anthropic. OpenAI and Google AI use the same template and
  are supported, but their output has not yet been measured against the golden set.
