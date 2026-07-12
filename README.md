# pushprep

> **Format → Stage → AI Commit. All in one command.**

`pushprep` is a globally-installable Node.js CLI tool that eliminates the repetitive pre-commit ritual before every `git push`. In one command it:

1. **Formats** changed files with Prettier (respects your `.prettierrc`)
2. **Shows** a clean git status of staged and unstaged files
3. **Stages** files interactively — all at once or via a checklist
4. **Generates** 3 AI-powered [Conventional Commit](https://www.conventionalcommits.org) message options via the **AI provider of your choice** — Google Gemini, Anthropic Claude, OpenAI, or a local model through Ollama
5. **Commits** with your chosen message

You just run `git push` afterward (or add `--push` to do it in one go).

---

## Installation

```bash
npm install -g pushprep
```

> Requires Node.js ≥ 18.0.0

---

## Quick Start

```bash
# Step 1: Pick a provider and add its key (one-time, interactive)
pushprep setup

# Step 2: Run inside any git project
cd your-project
pushprep
```

`pushprep setup` walks you through choosing a provider and adding a key. The very
first time you run `pushprep` without a key, it offers the same one-question
setup inline — so you can skip Step 1 entirely.

Prefer to run fully local with no API key? Choose **Ollama** in setup and pull a
model (e.g. `ollama pull llama3.2`).

---

## Providers

Choose whichever AI you already have. Each ships with a fast, low-cost default
model, and you can override it per provider with `--model`.

| Provider                    | Default model         | API key                                                                            |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| **Google Gemini** (default) | `gemini-flash-latest` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)           |
| **Anthropic Claude**        | `claude-haiku-4-5`    | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| **OpenAI**                  | `gpt-4o-mini`         | [platform.openai.com/api-keys](https://platform.openai.com/api-keys)               |
| **Ollama** (local)          | `llama3.2`            | none — runs on your machine ([ollama.com](https://ollama.com))                     |

```bash
pushprep setup                              # interactive: pick provider + key
pushprep config --provider claude --key ... # or configure one directly
pushprep --provider openai                  # use a provider for a single run
pushprep config --show                      # see all providers, keys, models
```

Keys are stored per provider, so you can keep several configured and switch with
`--provider` or `pushprep config --provider <name>`.

---

## Commands

| Command                            | Description                                        |
| ---------------------------------- | -------------------------------------------------- |
| `pushprep`                         | Run the full workflow (default)                    |
| `pushprep run`                     | Explicit alias for the default workflow            |
| `pushprep --push`                  | Run the workflow, then push to the remote          |
| `pushprep --amend`                 | Rewrite the previous commit's message              |
| `pushprep --provider <name>`       | Use a specific provider for this run               |
| `pushprep --model <name>`          | Use a specific AI model for this run               |
| `pushprep setup`                   | Pick a provider and add its key (interactive)      |
| `pushprep doctor`                  | Diagnose git, provider key, and model reachability |
| `pushprep config --provider <n>`   | Switch the active provider (or scope other flags)  |
| `pushprep config --key <key>`      | Save/update the key for the target provider        |
| `pushprep config --model <name>`   | Set the default model for the target provider      |
| `pushprep config --show`           | List all providers, key status, models, settings   |
| `pushprep config --remove`         | Delete the target provider's saved key             |
| `pushprep config --tips <on\|off>` | Toggle the subtle one-line UI tips                 |
| `pushprep --version`               | Print the installed version                        |
| `pushprep --help`                  | Print usage guide                                  |

**Environment variables** (all take precedence over saved config — handy for CI):
`PUSHPREP_PROVIDER` selects the provider; `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` supply per-provider keys, with `PUSHPREP_API_KEY` as a universal
fallback; `PUSHPREP_MODEL` overrides the model; `PUSHPREP_TIPS=0` silences tips.

---

## How It Works

### Phase 1 — Format

Detects all changed files and runs Prettier on each supported file type. Respects any `.prettierrc`, `.prettierrc.json`, or `prettier.config.js` in your project. Files that are already correctly formatted are left untouched.

**Supported extensions:** `.js` `.jsx` `.ts` `.tsx` `.css` `.scss` `.less` `.html` `.vue` `.svelte` `.json` `.yaml` `.yml` `.md` `.mdx` `.graphql` `.gql`

### Phase 2 — Status

Displays a clear view of unstaged files and already-staged files so you always know exactly what's going on.

### Phase 3 — Stage

Interactive staging menu:

- **Stage all files** — runs `git add .`
- **Choose specific files** — multi-select checklist with spacebar to toggle
- **Skip staging** — use files already in the staging area

### Phase 4 — AI Commit

Sends your staged diff (plus a per-file summary) to your chosen AI provider and gets back 3 [Conventional Commit](https://www.conventionalcommits.org) message options, each covering your **entire** changeset. All three suggestions are printed in full so you can read them before choosing. You can:

- **Pick one** and commit
- **🔄 Regenerate** for a fresh set if none fit
- **Edit** a suggestion inline before committing (pre-filled, so you just tweak)
- **Write your own** from scratch

If the provider is unavailable, a local fallback generates 3 context-aware messages from your staged file names.

### Model resilience

Each provider defaults to a stable, low-cost model and keeps a **fallback chain** of known-good models. If a model has been retired for your key, pushprep transparently tries the next one instead of silently degrading. Run `pushprep doctor` (optionally `--provider <name>`) any time to confirm your provider, key, and a model are actually reachable.

---

## AI Commit Messages

Commit messages follow the Conventional Commits format:

```
type(scope): description
```

Valid types: `feat` `fix` `refactor` `chore` `docs` `style` `test` `perf` `ci`

---

## Security

- Your API keys are stored locally at `~/.pushprep/config.json` — **never** in your project directory
- Keys are **never** logged in raw form — always masked in output
- Zero telemetry, zero analytics, zero data collection
- Each key is only transmitted to that provider's official API endpoint — and with **Ollama**, nothing leaves your machine at all

---

## Error Handling

pushprep never crashes with a raw stack trace. Every error:

1. Clearly states what went wrong
2. Explains why in plain English
3. Tells you exactly what to do next

| Scenario                 | Behavior                                          |
| ------------------------ | ------------------------------------------------- |
| Quota exhausted (429)    | Shows full quota error block with instructions    |
| Invalid API key          | Shows key setup instructions                      |
| Network error / timeout  | Falls back to local commit messages automatically |
| Not a git repository     | Exits with clear message                          |
| Ctrl+C at any prompt     | Exits cleanly with "Cancelled."                   |
| Prettier fails on a file | Shows warning, continues with other files         |

---

## Requirements

- Node.js ≥ 18.0.0
- Git installed and in your `PATH`
- An API key for one of the supported providers (Gemini, Claude, or OpenAI) — **or** [Ollama](https://ollama.com) running locally for a no-key setup

---

## License

MIT — [Aniket](https://github.com/aniket)
