# Changelog

All notable changes to **pushprep** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.1]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.1.1
[1.1.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.1.0
[1.0.0]: https://github.com/aniketsharma04/Pushprep/releases/tag/v1.0.0
