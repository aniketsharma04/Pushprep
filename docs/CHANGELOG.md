# Changelog

All notable changes to **pushprep** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-07-27

### Fixed

- **Every interactive run exited at the first prompt.** 1.2.0 shipped an ESC
  listener that called `process.stdin.unref()`, which tells Node that stdin
  doesn't count toward keeping the process alive. While a prompt waits for a
  keypress, stdin is the _only_ referenced handle — so Node considered itself
  idle and exited the moment the first menu appeared. The staging menu rendered,
  then dropped straight back to the shell with no error and no cancel message.
  The listener is now left referenced and torn down explicitly when the run
  finishes, which was the actual goal of the `unref()`.

  1.2.0 is unusable interactively; upgrade to 1.2.1.

## [1.2.0] - 2026-07-27

"Bring your own AI." pushprep is no longer tied to Gemini — pick the provider you
already have, whether that's a cloud key or a model running locally on your
machine. This release also folds in a small set of subtle, one-line UI tips.

### Added

- **Multi-provider support** — choose between **Google Gemini** (default),
  **Anthropic Claude**, **OpenAI**, and **Ollama** (local, no key). Each uses a
  fast, cheap default model (`gemini-flash-lite-latest`, `claude-haiku-4-5`,
  `gpt-4o-mini`, `llama3.2`).
- **`pushprep setup`** — an interactive wizard to pick a provider and add its key.
  The wizard shows each provider's key-generation link inline and lets you set a
  model. The same one-question setup is offered inline the first time a run finds
  no key, and it's also reachable as `pushprep --config`.
- **Automatic self-update** — a global install checks for a newer published
  version (cached, non-blocking, 3s timeout) and, when one exists, installs it
  and relaunches the same command on the new version. Best-effort and silent:
  offline, lack of permissions, dev checkouts, and CI all fall through to the
  current version. Opt out with `PUSHPREP_NO_UPDATE=1`.
- **`--provider <name>` flag** and **`PUSHPREP_PROVIDER`** env var to select the
  provider per run.
- **Per-provider keys and models** — `pushprep config --provider <name> --key ...`
  / `--model ...` store settings independently for each provider.
- **Cross-provider fallback** — if the active provider fails (quota/limit,
  rejected key, network), pushprep automatically switches to another provider you
  have a key for, showing a message like "OpenAI reached its limit — switching to
  Google Gemini." Local fallback messages are only used when every configured
  provider is exhausted, so a commit still gets a real AI message far more often.
- **`pushprep config --show`** now lists every provider with its key status,
  saved model, and which one is active.
- **Ollama support** — runs entirely locally with no API key; `doctor` checks the
  server is up and the chosen model is pulled, with an actionable "pull it"
  message when it isn't.
- **Subtle one-line tips** at key moments (e.g. "space to select · enter to
  confirm") plus a gentle "run `pushprep --help`" nudge at the start of and
  during a run. Dim, never more than one line; turn them off with
  `pushprep config --tips off` or `PUSHPREP_TIPS=0`.
- **Curated `pushprep --help`** — a hand-written "Commands" section listing the
  everyday commands (workflow, `--push`, `--amend`, `--provider`, `--model`,
  `setup`, `doctor`, and the `config --show/--provider/--model/--key` family)
  instead of an auto-generated subcommand dump. `config --show` also now
  prints the active model on its own line.
- **Safe cancel** — pressing **Ctrl+C or Esc** anywhere before the commit is made
  now unstages exactly the files pushprep staged this run, so an aborted run no
  longer silently leaves that work staged. Files you had staged before running
  pushprep (that it didn't touch) are left alone, and working-tree contents are
  never modified. (A future release will make Esc step _back_ one prompt at a
  time instead of exiting outright.)
- **"Don't commit — exit" option** in the commit-message menu, for stopping
  cleanly without committing. When pushprep staged files this run it asks whether
  to keep them staged (default yes) or revert.
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

### Fixed

- The Gemini reliability fixes first shipped in **[1.1.1](#111---2026-07-27)** —
  a valid key no longer reported as invalid, `thinkingConfig` no longer sent to
  models that reject it, retired models dropped from the chain, and quota
  failures advancing the chain instead of ending the run — are carried forward
  here and generalized to every provider. Error classification, the
  "the model rejected the request — not your API key" message, and the
  advance-on-recoverable-failure rule now live in the shared `src/prompt.js`
  layer, so Claude, OpenAI, and Ollama get the same handling rather than each
  reimplementing it.

## [1.1.1] - 2026-07-27

A patch release fixing the Gemini failure that dropped every run into the generic
local fallback while blaming a perfectly valid API key.

### Fixed

- **A valid API key was reported as invalid.** Any `400` from Gemini was
  classified as a rejected key, so pushprep printed "🔑 Invalid Gemini API Key"
  and fell back to generic local messages — sending users to rotate a key that
  was working fine. Gemini returns `400 INVALID_ARGUMENT` for any malformed
  request, and pushprep was sending one (below). A bad key is now only inferred
  from `401`/`403` or an explicit "API key not valid" message; a genuine `400`
  reports as "Gemini rejected the request — not your API key".
- **The request Gemini was rejecting.** pushprep sent
  `thinkingConfig: { thinkingBudget: 0 }` to disable reasoning tokens, but the
  current `gemini-flash-latest` and `gemini-flash-lite-latest` endpoints reject
  that field outright. It is now sent only to thinking-capable models, and a
  model that rejects it anyway is retried once without it.
- **Retired models in the fallback chain.** `gemini-2.5-flash-lite` and
  `gemini-2.5-flash` now return _"no longer available to new users"_ for keys
  created recently. They are out of the chain, and that wording is recognized as
  a retired model.
- **A single exhausted model no longer ends the run.** Gemini's free-tier quota
  is counted per model, so a `429` on one left the remaining models untried.
  Quota and bad-request failures now advance down the model chain the same way a
  retired model does — in both generation and `pushprep doctor`, which had been
  able to declare a healthy key dead on the first model it tried.

### Changed

- **Default model is now `gemini-flash-lite-latest`** (was `gemini-flash-latest`).
  Flash-Lite does no "thinking", so it spends no reasoning tokens on a task that
  doesn't need them: a commit that previously cost reasoning tokens on top of the
  output now costs none, and a free-tier key stretches considerably further.
- **Diff budget trimmed from 20,000 to 12,000 characters**, and generation capped
  at 1,200 output tokens. The complete file list and `--stat` summary are still
  sent in full, so every file is still accounted for in the message.

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

[1.2.1]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.2.1
[1.2.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.2.0
[1.1.1]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.1.1
[1.1.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.1.0
[1.0.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.0.0
