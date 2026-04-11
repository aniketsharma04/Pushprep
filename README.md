# pushprep

> **Format → Stage → AI Commit. All in one command.**

`pushprep` is a globally-installable Node.js CLI tool that eliminates the repetitive pre-commit ritual before every `git push`. In one command it:

1. **Formats** changed files with Prettier (respects your `.prettierrc`)
2. **Shows** a clean git status of staged and unstaged files
3. **Stages** files interactively — all at once or via a checklist
4. **Generates** 3 AI-powered [Conventional Commit](https://www.conventionalcommits.org) message options via Google Gemini
5. **Commits** with your chosen message

You just run `git push` afterward.

---

## Installation

```bash
npm install -g pushprep
```

> Requires Node.js ≥ 18.0.0

---

## Quick Start

```bash
# Step 1: Save your Gemini API key (one-time setup)
pushprep config --key YOUR_GEMINI_API_KEY

# Step 2: Run inside any git project
cd your-project
pushprep
```

Get a free Gemini API key at: **https://aistudio.google.com/app/apikey**

---

## Commands

| Command | Description |
|---|---|
| `pushprep` | Run the full workflow (default) |
| `pushprep run` | Explicit alias for the default workflow |
| `pushprep config --key <key>` | Save or update your Gemini API key |
| `pushprep config --show` | Display masked API key and config file path |
| `pushprep config --remove` | Delete the saved API key |
| `pushprep --version` | Print the installed version |
| `pushprep --help` | Print usage guide |

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
Sends your staged diff to Google Gemini and gets back 3 [Conventional Commit](https://www.conventionalcommits.org) message options. You pick one (or write your own), confirm, and the commit is created.

If Gemini is unavailable, a local fallback generates 3 context-aware messages from your staged file names.

---

## AI Commit Messages

Commit messages follow the Conventional Commits format:

```
type(scope): description
```

Valid types: `feat` `fix` `refactor` `chore` `docs` `style` `test` `perf` `ci`

---

## Security

- Your API key is stored locally at `~/.pushprep/config.json` — **never** in your project directory
- The key is **never** logged in raw form — always masked in output
- Zero telemetry, zero analytics, zero data collection
- The key is only transmitted to Google's official Gemini endpoint

---

## Error Handling

pushprep never crashes with a raw stack trace. Every error:
1. Clearly states what went wrong
2. Explains why in plain English
3. Tells you exactly what to do next

| Scenario | Behavior |
|---|---|
| Quota exhausted (429) | Shows full quota error block with instructions |
| Invalid API key | Shows key setup instructions |
| Network error / timeout | Falls back to local commit messages automatically |
| Not a git repository | Exits with clear message |
| Ctrl+C at any prompt | Exits cleanly with "Cancelled." |
| Prettier fails on a file | Shows warning, continues with other files |

---

## Requirements

- Node.js ≥ 18.0.0
- Git installed and in your `PATH`
- A [Google Gemini API key](https://aistudio.google.com/app/apikey) (free)

---

## License

MIT — [Aniket](https://github.com/aniket)
