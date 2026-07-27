# pushprep — Version History

A running log of every released version of **pushprep**, why it shipped, and what
changed. This is the human story behind the releases; the machine-readable list
of changes lives in [`./CHANGELOG.md`](./CHANGELOG.md).

> **How we use this doc:** every time we cut a new version, add a new `## vX.Y.Z`
> section at the **top** of the "Releases" list below (newest first), fill in the
> theme, the highlights, and the reasoning. Keep the [Version index](#version-index)
> table in sync.

---

## Version index

| Version        | Date       | Theme                             | Status      |
| -------------- | ---------- | --------------------------------- | ----------- |
| [1.2.0](#v120) | 2026-07-12 | Bring your own AI + friendlier UX | ✅ Released |
| [1.1.0](#v110) | 2026-07-12 | Reliability + workflow            | ✅ Released |
| [1.0.0](#v100) | 2026-04-12 | Initial release                   | ✅ Released |

**Current version:** `1.2.0`

---

## Releases

### v1.2.0

- **Date:** 2026-07-12
- **Theme:** _"Bring your own AI."_ — multi-provider support + a friendlier,
  more discoverable experience.
- **Status:** ✅ Released

**Why this release**

Until now pushprep was hard-wired to Google Gemini. If you didn't have a Gemini
key — or you already paid for Claude/OpenAI, or you wanted to run fully local —
you were stuck. v1.2 makes the AI a choice, not a requirement, and smooths out
the rough edges that new users hit on their first run.

**Highlights**

- **Multi-provider support** — Google Gemini (default), Anthropic Claude, OpenAI,
  and Ollama (local, no API key). Each ships a fast, cheap default model.
- **`pushprep setup` wizard** — pick a provider and add its key interactively;
  the same one-question setup appears inline on your first keyless run.
- **Cross-provider fallback** — if the active provider fails (quota, bad key,
  network), pushprep automatically switches to another provider you've configured
  before ever dropping to local messages.
- **Automatic self-update** — a global install quietly updates itself to the
  latest published version and relaunches your command. Opt out with
  `PUSHPREP_NO_UPDATE=1`.
- **Friendlier UX** — subtle one-line tips at key moments, a gentle
  "run `pushprep --help`" nudge, and a curated (hand-written) help screen with a
  real "Commands" section instead of an auto-generated dump.
- **Safe cancel** — pressing **Ctrl+C or Esc** anywhere before the commit
  unstages exactly the files pushprep staged this run; files you staged
  beforehand are left alone, and your working tree is never touched.
- **"Don't commit — exit" menu option** — stop cleanly without committing, and
  choose whether to keep the staged files (default: keep).

**Also worth knowing**

- The AI internals were refactored into a clean provider abstraction
  (`src/prompt.js` shared logic, `src/providers/*`, `src/ai.js` dispatcher) — a
  zero-behavior-change foundation for adding future providers.
- The config file moved to a versioned multi-provider schema; existing single-key
  configs migrate automatically on first write.
- **Security:** bumped `simple-git` to `^3.36.0` to clear a high-severity RCE
  advisory (GHSA-hffm-xvc3-vprc).

---

### v1.1.0

- **Date:** 2026-07-12
- **Theme:** Reliability + workflow.
- **Status:** ✅ Released

**Why this release**

The previous default model (`gemini-2.5-flash`) had been **retired for new API
keys**. Every run silently fell through to the generic local fallback — which was
the real reason commit messages had gotten low-quality. v1.1 fixed that at the
root and added the workflow features that make pushprep a one-command tool.

**Highlights**

- **Model fallback chain** — if a model is retired or unreachable, pushprep tries
  the next known-good model instead of degrading to the generic fallback. The
  default is now the floating `gemini-flash-latest` alias.
- **`pushprep doctor`** — a health check for Node version, git repo, API key, and
  live model reachability, with a fix hint for anything that fails.
- **`--model` flag + `PUSHPREP_MODEL`** — override the model per run.
- **🔄 Regenerate** in the commit menu — a fresh set of suggestions when none fit.
- **`--push` flag + end-of-run push prompt** — pushes the _current_ branch (not
  hardcoded `main`) and auto-sets the upstream on a branch's first push.
- **`--amend`** — regenerate and rewrite the previous commit's message, even on a
  clean tree.
- **Inline commit editing** — tweak a chosen suggestion instead of retyping it.
- **Full changeset context** — the staged diff is sent with a per-file `--stat`
  summary so multi-file commits are described in full.
- **Test suite + CI** — unit, smoke, and live reachability tests across Node
  18/20/22.

**Fixes**

- Commit bodies with literal `\n` now render as real multi-line text.
- The status view no longer double-lists a fully-staged file under both
  "Unstaged" and "Already staged".

---

### v1.0.0

- **Date:** 2026-04-12
- **Theme:** Initial release.
- **Status:** ✅ Released

The first public release: the **Format → Stage → AI Commit** workflow in one
command — Prettier formatting, interactive staging, Gemini-powered Conventional
Commit suggestions, and local fallback messages.

---

## Roadmap / ideas

Space for what's coming next. Move items up into a real release section once they
ship.

- **Esc = step back one prompt (planned).** Today Esc _cancels the whole run_
  (same as Ctrl+C). The planned behavior: pressing Esc walks you **backwards one
  step at a time** instead of exiting. From the commit step, one Esc returns you
  to the staging step and unstages the files staged this run; pressing Esc again
  at the first step (nothing left to go back to) exits pushprep — mirroring how
  people expect Esc to work in modern CLIs. Needs a small step/state machine
  around the prompt flow (clack has no built-in back navigation), so it's its own
  release rather than a bolt-on.
- _(v1.3 — context-aware: planned)_ — see the project roadmap notes.

---

_Last updated for **v1.2.0** (2026-07-26)._
