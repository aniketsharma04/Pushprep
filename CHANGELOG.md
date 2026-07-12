# Changelog

All notable changes to **pushprep** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-12

"Bring your own AI." pushprep is no longer tied to Gemini — pick the provider you
already have, whether that's a cloud key or a model running locally on your
machine. This release also folds in a small set of subtle, one-line UI tips.

### Added

- **Multi-provider support** — choose between **Google Gemini** (default),
  **Anthropic Claude**, **OpenAI**, and **Ollama** (local, no key). Each uses a
  fast, cheap default model (`gemini-flash-latest`, `claude-haiku-4-5`,
  `gpt-4o-mini`, `llama3.2`).
- **`pushprep setup`** — an interactive wizard to pick a provider and add its key.
  The same one-question setup is offered inline the first time a run finds no key.
- **`--provider <name>` flag** and **`PUSHPREP_PROVIDER`** env var to select the
  provider per run.
- **Per-provider keys and models** — `pushprep config --provider <name> --key ...`
  / `--model ...` store settings independently for each provider.
- **`pushprep config --show`** now lists every provider with its key status,
  saved model, and which one is active.
- **Ollama support** — runs entirely locally with no API key; `doctor` checks the
  server is up and the chosen model is pulled, with an actionable "pull it"
  message when it isn't.
- **Subtle one-line tips** at key moments (e.g. "space to select · enter to
  confirm"). Dim, never more than one line; turn them off with
  `pushprep config --tips off` or `PUSHPREP_TIPS=0`.
- Provider-specific env vars for keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
  (alongside the existing `GEMINI_API_KEY`), plus `PUSHPREP_API_KEY` as a
  universal fallback.

### Changed

- `pushprep doctor` and `--model` now operate against the **active provider**
  instead of assuming Gemini, and `doctor` reports which provider it's checking.
- AI internals were refactored into a provider abstraction
  (`src/prompt.js` shared logic, `src/providers/*`, `src/ai.js` dispatcher). This
  is a zero-behavior-change foundation for existing Gemini users.
- The config file gained a versioned multi-provider schema; existing single-key
  configs are migrated automatically on first write. Existing installs keep
  working with no action needed.

### Security

- Bumped **simple-git** to `^3.36.0` to clear a high-severity remote-code-execution
  advisory (GHSA-hffm-xvc3-vprc).

## [1.1.0] - 2026-07-12

A reliability + workflow release. The headline fix: the previous default model
(`gemini-2.5-flash`) had been **retired for new API keys**, which silently pushed
every run into the generic local fallback — the root cause of low-quality commit
messages. pushprep now defaults to a resilient model alias with a fallback chain.

### Added

- **Model fallback chain** — if a model is retired or unreachable, pushprep
  transparently tries the next known-good model instead of degrading to the
  generic fallback.
- **`pushprep doctor`** — health check for Node version, git repository, API key,
  and live model reachability, with a fix hint for anything that fails.
- **`--model <name>` flag** and **`PUSHPREP_MODEL`** env var to override the AI
  model per run.
- **`GEMINI_API_KEY` / `PUSHPREP_API_KEY` env var support** — takes precedence
  over the saved config (handy for CI).
- **🔄 Regenerate** option in the commit menu — fetch a fresh set of suggestions
  (with higher variety) when none fit.
- **`--push` flag** and an end-of-run **"Push … to remote now?"** prompt. Pushes
  the **current** branch (not hardcoded to `main`) and auto-sets the upstream on
  a branch's first push.
- **`--amend`** — regenerate and rewrite the previous commit's message; works
  even on a clean working tree.
- **Inline commit editing** — a Commit / Edit / Cancel step lets you tweak a
  chosen suggestion (pre-filled) instead of retyping it.
- **Full staged-changeset context** — the staged diff is sent alongside a
  per-file `--stat` summary so multi-file commits are described in full.
- **Test suite + CI** — unit, smoke, and live model-reachability tests
  (`node --test`) plus a GitHub Actions workflow across Node 18/20/22.

### Changed

- Default model is now the floating **`gemini-flash-latest`** alias, so the tool
  no longer breaks when a specific model version is retired.
- Commit-message prompt rewritten to describe the **entire** changeset across all
  files (previously it often described only one), with accurate, non-filler
  bodies and three genuinely alternative phrasings of the same change.
- Model "thinking" is disabled for generation, roughly halving latency
  (~25s → ~12s) so runs no longer time out into the fallback.
- Diff budget raised from 6,000 to 20,000 characters.
- All three suggestions are now printed in full above the menu so the complete
  message is readable before you choose.

### Fixed

- Commit-message bodies containing literal `\n` sequences now render and commit
  as real multi-line text.
- The status view no longer lists a fully-staged file under both "Unstaged" and
  "Already staged" (now classified via git porcelain codes).

## [1.0.0] - 2026-04-12

- Initial release: Format → Stage → AI Commit workflow with Prettier, interactive
  staging, Gemini-powered Conventional Commit suggestions, and local fallback
  messages.

[1.2.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.2.0
[1.1.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.1.0
[1.0.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.0.0
