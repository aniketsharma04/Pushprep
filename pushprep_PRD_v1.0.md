# pushprep — Product Requirements Document

**Format → Stage → AI Commit. All in one command.**

---

| Field            | Detail                              |
|------------------|-------------------------------------|
| Product Name     | pushprep                            |
| Document Type    | Product Requirements Document (PRD) |
| Version          | 1.0                                 |
| Author           | Aniket                              |
| Status           | Active Development                  |
| Target Platform  | npm (Node.js CLI, global install)   |
| Target Audience  | Frontend / Full-stack Developers    |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Product Overview](#3-product-overview)
4. [Functional Requirements](#4-functional-requirements)
5. [Error Handling Specification](#5-error-handling-specification)
6. [Technical Architecture](#6-technical-architecture)
7. [User Experience & CLI Design](#7-user-experience--cli-design)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Publishing & Distribution](#9-publishing--distribution)
10. [Future Roadmap](#10-future-roadmap-post-v10)
11. [Success Metrics](#11-success-metrics)
12. [Appendix](#12-appendix)

---

## 1. Executive Summary

`pushprep` is a globally-installable Node.js CLI tool published on npm. It eliminates the repetitive and error-prone pre-commit ritual that developers perform before every `git push`. In a single command, `pushprep`:

1. **Formats** changed files using Prettier (respects the project's `.prettierrc`)
2. **Shows** a clear git status of staged and unstaged files
3. **Stages** files interactively — all at once or specific ones chosen from a checklist
4. **Generates** 3 AI-powered Conventional Commit message options via the Google Gemini API
5. **Commits** with the developer's chosen message

The developer only needs to run `git push` afterward. pushprep handles everything before that.

---

## 2. Problem Statement

### 2.1 The Developer Pain Point

Every developer goes through the same ritual before every push. It's fragmented, requires active memory, and breaks momentum:

1. Remember to run Prettier before staging
2. Run `git status` to see what changed
3. Decide which files to stage and run `git add` manually
4. Think of a meaningful commit message and type it out
5. Run `git commit -m`
6. Finally `git push`

Each step is individually simple but collectively creates friction — so developers skip steps (especially formatting and meaningful commit messages), leading to messy git histories and inconsistent codebases.

### 2.2 What Goes Wrong Without pushprep

| Problem | Impact |
|---|---|
| Skipping Prettier | Inconsistent code style across files and teammates |
| Lazy commit messages | `git log` becomes useless; harder to review PRs and debug |
| Over-staging (`git add .`) | Accidentally committing debug code, `.env` files, build artifacts |
| Under-staging | Missing files in a commit; broken builds for teammates |
| Mental overhead | Breaks flow state; developers rush through the process |

---

## 3. Product Overview

### 3.1 The Four Phases

| Phase | Name | What Happens |
|---|---|---|
| 1 | **Format** | Detect all changed files. Run Prettier on each formattable file. Respects `.prettierrc`. Write formatted output back to disk. |
| 2 | **Status** | Use `simple-git` to display staged files and unstaged/untracked files clearly. |
| 3 | **Stage** | Interactive prompt: stage all, stage specific files from a checklist, or skip. |
| 4 | **AI Commit** | Send `git diff --staged` to Gemini. Get 3 Conventional Commit options. Developer picks one (or writes custom). Commit is created. |

### 3.2 What pushprep Does NOT Do

- `pushprep` does **not** run `git push`. This is intentional — the developer retains full control over when and where their code is pushed.
- `pushprep` does **not** modify any git history.
- `pushprep` does **not** enforce a specific Prettier config. It uses whatever the project already has.

### 3.3 Quick Start (3 Steps)

```bash
# Step 1: Install globally
npm install -g pushprep

# Step 2: Save your Gemini API key (one-time setup)
pushprep config --key YOUR_GEMINI_API_KEY

# Step 3: Run inside any git project
cd your-project
pushprep
```

Get a free Gemini API key at: https://aistudio.google.com/app/apikey

---

## 4. Functional Requirements

### 4.1 CLI Commands

| Command | Arguments | Description |
|---|---|---|
| `pushprep` | (none) | Runs the full workflow (default command) |
| `pushprep run` | (none) | Explicit alias for the default workflow |
| `pushprep config` | `--key <api_key>` | Save or update the Gemini API key |
| `pushprep config` | `--show` | Display masked API key and config file path |
| `pushprep config` | `--remove` | Delete the saved API key from local storage |
| `pushprep --version` | (none) | Print the installed version number |
| `pushprep --help` | (none) | Print usage guide with examples |

---

### 4.2 Phase 1 — Code Formatting

#### 4.2.1 Supported File Extensions

Prettier is run on files with these extensions:

```
.js  .jsx  .ts  .tsx  .css  .scss  .less
.html  .vue  .svelte  .json  .yaml  .yml
.md  .mdx  .graphql  .gql
```

#### 4.2.2 Prettier Configuration Resolution

- Call `prettier.resolveConfig(filePath)` for each file
- If a `.prettierrc`, `.prettierrc.json`, `prettier.config.js`, or equivalent exists in the project → it is automatically used
- If no project-level config found → Prettier's default settings are applied
- `pushprep` does **not** ship or enforce its own opinionated Prettier config

#### 4.2.3 Formatting Behavior

- Only **changed files** (unstaged + untracked) are formatted, not the entire codebase
- If a file is already formatted correctly → shown as `• Already clean: filename` and left untouched
- Files Prettier cannot parse (binary files, unknown extensions) → silently skipped via `prettier.getFileInfo()`
- Formatting errors on individual files → shown as a `⚠` warning but do **not** abort the workflow
- Formatted files are written back to disk immediately

---

### 4.3 Phase 2 — Git Status Display

After formatting, display:

- **Unstaged files** — modified + deleted + untracked (count shown in header)
- **Already staged files** — files already in the staging area (count shown in header)
- If zero changed files detected after formatting → exit cleanly with "Nothing to commit" message

---

### 4.4 Phase 3 — Interactive File Staging

#### 4.4.1 Staging Options

When unstaged files exist, present a `@clack/prompts` select menu with three options:

| Option | Git Equivalent | Behavior |
|---|---|---|
| Stage all files | `git add .` | Stages every changed and untracked file |
| Choose specific files | `git add <file1> <file2>` | Opens a multi-select checklist of all changed files |
| Skip staging | (none) | Proceeds with files already in the staging area |

#### 4.4.2 Multi-Select File Picker (for "Choose specific files")

- All unstaged and untracked files listed as toggleable checkboxes
- Developer uses spacebar to toggle, Enter to confirm
- At least 1 file must be selected (prompt validates this)
- Only the selected files are passed to `git add`

#### 4.4.3 Post-Staging Validation

- After staging, re-check `git status` to confirm staged files exist
- If no staged files found (e.g., developer chose "Skip" but nothing was staged) → show warning and exit gracefully

---

### 4.5 Phase 4 — AI Commit Message Generation

#### 4.5.1 Diff Extraction

- Run `git diff --staged` to get the complete diff of staged changes
- Truncate diff to **3000 characters** before sending to Gemini (prevents excessive token usage)
- Also pass the list of staged file names as additional context

#### 4.5.2 Gemini Prompt Design

The prompt instructs the model to act as a senior software engineer and generate exactly 3 commit messages with these rules:

- Follow **Conventional Commits** format: `type(scope): description`
- Valid types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`, `ci`
- Each message must be **under 72 characters**
- Three options must approach the change from **different angles** (what changed / why / impact)
- Response must be a **raw JSON array of 3 strings** — no markdown, no preamble, no backticks

Example expected response:
```json
["feat(auth): add JWT token refresh logic", "fix(auth): prevent session expiry on active users", "refactor(auth): improve token validation flow"]
```

#### 4.5.3 Commit Message Selection UI

1. Show the 3 AI-generated options in a `@clack/prompts` select menu
2. Always include a 4th option: `✏️ Write my own commit message`
3. If developer picks custom → show a text input with live validation:
   - Non-empty required
   - Max 100 characters
4. After selection → show a confirmation prompt: `Commit with: "message"? (Y/n)`
5. On confirm → run `git commit -m "message"`

#### 4.5.4 Local Fallback Messages

If Gemini returns an unusable response or the API call fails entirely, generate 3 context-aware fallback messages locally using the staged file names:

```
chore(<scope>): update files and apply formatting
refactor(<scope>): clean up code structure
fix(<scope>): apply changes and fixes
```

Where `<scope>` is derived from the first staged file's name (without extension).

---

## 5. Error Handling Specification

### 5.1 Error Philosophy

Every error in `pushprep` must be **actionable**. The user must never see a raw JavaScript stack trace. Every error message must:

1. Clearly state **what went wrong**
2. Explain **why** it happened in plain English
3. Tell the user **exactly what to do next**

### 5.2 Gemini API Error Matrix

| HTTP Code | Error Type | User-Facing Message | Resolution Shown to User |
|---|---|---|---|
| `429` | Quota Exhausted / Rate Limit | "🚫 Gemini API Quota Exhausted" | Get new key from a different Google account at `aistudio.google.com` |
| `401` | Unauthorized | "🔑 Invalid Gemini API Key" | Verify key at `aistudio.google.com`, re-run `pushprep config --key` |
| `403` | Permission Denied | "🔑 Invalid Gemini API Key" | Check key restrictions in Google AI Studio |
| `400` | Bad Request / Invalid Key | "🔑 Invalid Gemini API Key" | Re-enter key using `pushprep config --key` |
| Model Error | Model Not Found | "⚠️ Gemini model unavailable" | Update pushprep to latest version |
| Network | Timeout / ECONNREFUSED | "⚠️ Network error" | Check internet connection and retry |
| Safety | Content Blocked | "⚠️ Gemini blocked the request" | Fallback messages shown automatically |
| Parse | Invalid JSON from Gemini | "⚠️ Could not parse AI response" | Fallback messages shown automatically |

### 5.3 Quota Exhaustion — Full Terminal Output

This is the most critical error case. The exact terminal output must look like this:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🚫 Gemini API Quota Exhausted
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Your current Gemini API key has run out of tokens/requests.

  What you can do:
  1. Get a new API key from a different Google account:
     → https://aistudio.google.com/app/apikey

  2. Update pushprep with the new key:
     → pushprep config --key YOUR_NEW_API_KEY

  3. Or wait for your quota to reset (usually 24h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 5.4 Error Detection Logic (in `ai.js`)

Detect quota errors by checking for **any** of the following:

```js
status === 429
|| message.includes("429")
|| message.toLowerCase().includes("quota")
|| message.toLowerCase().includes("rate limit")
|| message.toLowerCase().includes("resource has been exhausted")
|| message.toLowerCase().includes("too many requests")
```

Detect invalid key errors by checking for **any** of the following:

```js
status === 400 || status === 401 || status === 403
|| message.toLowerCase().includes("api key not valid")
|| message.toLowerCase().includes("invalid api key")
|| message.toLowerCase().includes("permission denied")
|| message.toLowerCase().includes("unauthorized")
```

### 5.5 Non-API Errors

| Scenario | Detection | Behavior |
|---|---|---|
| Not a git repository | `git.status()` throws | Exit with: "Not a git repository. Run pushprep inside a git project." |
| No API key configured | `getApiKey()` returns `null` | Exit with instructions to run `pushprep config --key` |
| No changed files | `allChanged.length === 0` | Exit with: "Nothing to stage or commit. You're all clean! 🎉" |
| No staged files after staging | `staged.length === 0` | Exit with warning to stage files first |
| Prettier fails on a file | `try/catch` per file | Show `⚠` warning for that file, continue with the rest |
| User presses Ctrl+C | `p.isCancel()` check at every prompt | Show "Cancelled." gracefully, no crash, `process.exit(0)` |
| Config file corrupted | `JSON.parse` try/catch | Return empty config, continue as fresh install |

---

## 6. Technical Architecture

### 6.1 Project File Structure

```
pushprep/
├── src/
│   ├── cli.js          ← Entry point. Commander setup + main workflow orchestration
│   ├── ai.js           ← Gemini API integration + full error handling
│   ├── config.js       ← API key read/write (~/.pushprep/config.json)
│   ├── formatter.js    ← Prettier programmatic API wrapper
│   └── git.js          ← All git operations via simple-git
├── package.json
├── .npmignore
└── README.md
```

### 6.2 Module Responsibilities

#### `cli.js`
- Define the Commander program, version, and all sub-commands
- Implement the main `runPushPrep()` async function that orchestrates all four phases in sequence
- All `@clack/prompts` UI interactions (select, multiselect, text, confirm, spinner, intro, outro)
- Import and call functions from all other modules
- Call `commitWithMessage()` as the final step

#### `ai.js`
- Initialize `GoogleGenerativeAI` with the user's API key
- Build the Gemini prompt string (with diff + file list)
- Call `model.generateContent()` and parse the JSON array response
- Classify all API errors (quota, invalid key, network, safety, parse) and display formatted messages
- Generate local fallback commit messages when AI fails

#### `config.js`
- Create `~/.pushprep/` directory if it doesn't exist
- Read/write `~/.pushprep/config.json`
- Expose: `saveApiKey(key)`, `getApiKey()`, `removeApiKey()`, `showConfig()`
- Mask key in `showConfig()` output: show first 6 chars + bullets + last 4 chars

#### `formatter.js`
- Filter changed files by supported extension list
- For each file: call `prettier.resolveConfig()`, `prettier.getFileInfo()`, `prettier.format()`
- Write formatted content back to disk if it differs from original
- Return `{ formatted: [], failed: [] }` summary

#### `git.js`
- Expose: `isGitRepo()`, `getGitStatus()`, `getAllChangedFiles()`, `stageAllFiles()`, `stageSpecificFiles(files)`, `getStagedFiles()`, `getDiff()`, `commitWithMessage(message)`
- All operations use `simple-git` — no shelling out with `exec`

### 6.3 Dependency Stack

| Package | Version | Purpose |
|---|---|---|
| `prettier` | `^3.2.5` | Code formatting engine — used as a library, not shelled out |
| `simple-git` | `^3.22.0` | Node.js wrapper for all git CLI operations |
| `@clack/prompts` | `^0.7.0` | Interactive terminal prompts (select, multiselect, text, confirm, spinner) |
| `@google/generative-ai` | `^0.21.0` | Official Google Gemini SDK for Node.js |
| `commander` | `^12.0.0` | CLI argument parsing, sub-commands, help text, version flag |
| `chalk` | `^5.3.0` | Terminal string styling — colors, bold, dim (ESM-only in v5) |

### 6.4 `package.json` Key Fields

```json
{
  "name": "pushprep",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "pushprep": "src/cli.js"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

- `"type": "module"` — required because `chalk` v5 is ESM-only. All files use `import/export`.
- `"bin"` — registers the `pushprep` command globally when installed with `-g`
- `"engines"` — enforces Node >= 18 at install time

### 6.5 API Key Storage

- Stored at: `~/.pushprep/config.json`
- Format: `{ "geminiApiKey": "AIzaSy..." }`
- Directory created automatically on first `pushprep config --key` run
- Key is **never** logged to stdout in raw form
- Key is **never** committed to any git repository (stored outside project directories)
- Key is only transmitted to: `https://generativelanguage.googleapis.com` (official Google Gemini endpoint)

### 6.6 Runtime Requirements

- Node.js >= 18.0.0
- Git installed and available in system `PATH`
- npm (for global installation)
- Internet connection (only needed for Gemini API calls)

---

## 7. User Experience & CLI Design

### 7.1 Complete Terminal Session Walkthrough

```
$ pushprep

  ██████╗ ██╗   ██╗███████╗██╗  ██╗██████╗ ██████╗ ███████╗██████╗
  [... ASCII banner in bold cyan ...]

  Format → Stage → AI Commit. All in one command.

  ◆  Starting your pre-push workflow...

  ◇  Running Prettier on changed files...
  Found 3 changed file(s). Formatting...

  ✓ Formatted: src/components/Button.jsx
  • Already clean: src/utils/helpers.js
  ✓ Formatted: src/styles/main.css

  📂 Unstaged files (3):
     • src/components/Button.jsx
     • src/utils/helpers.js
     • src/styles/main.css

◆  How do you want to stage your files?
   ● Stage all files          (git add .)
   ○ Choose specific files    (Pick from the list)
   ○ Skip staging             (Use already staged files)

  ✅ All files staged (git add .)

  ◇  Asking Gemini AI to generate commit messages...
  Got 3 commit message suggestions! ✨

◆  Choose your commit message:
   ● feat(button): add hover state and style improvements        Option 1
   ○ style(ui): apply consistent formatting across components    Option 2
   ○ refactor(components): clean up button and helper logic      Option 3
   ○ ✏️  Write my own commit message

◆  Commit with: "feat(button): add hover state and style improvements"?
   ● Yes  ○ No

  ✅ Committed: "feat(button): add hover state and style improvements"

  ◆  🚀 All done! Run git push whenever you're ready.
```

### 7.2 UX Principles

- **Lead with action** — the workflow starts immediately; no config prompts during normal use
- **Progressive disclosure** — staged files section is only shown if staged files exist
- **Optimistic defaults** — "Stage all files" is the first (default) option
- **Cancellable at every step** — `Ctrl+C` is caught via `p.isCancel()` at every prompt; always exits with "Cancelled." message and `process.exit(0)`
- **No silent failures** — every error, skip, or warning is communicated
- **Color with purpose** — green = success, yellow = warning, red = error, dim = secondary info, cyan = brand/highlights
- **Spinners for async** — formatting and AI generation show live spinners

### 7.3 ASCII Banner

- Shown at the start of every `pushprep` (default) run
- Rendered in `chalk.bold.cyan`
- Not shown for `pushprep config` sub-commands

---

## 8. Non-Functional Requirements

| Category | Requirement | Detail |
|---|---|---|
| Performance | Cold start < 500ms | Excluding Prettier format time and Gemini API latency |
| Performance | Gemini API timeout | If Gemini takes > 15s, fall back to local messages automatically |
| Reliability | No crash on any user error | All user-facing errors exit via `process.exit(0 or 1)` — never uncaught exceptions |
| Reliability | No crash on Gemini failure | All API errors are caught and handled — workflow ends gracefully or uses fallback |
| Security | API key never logged raw | Masked in all display outputs (`AIzaSy••••••••••••y8Xz`) |
| Security | No telemetry | Zero usage data, analytics, or tracking of any kind |
| Compatibility | macOS + Linux + Windows | All file paths use Node.js cross-platform APIs (no hardcoded `/` or `\`) |
| Compatibility | Node.js >= 18 enforced | Via `"engines"` field in `package.json` |
| Usability | Zero config for formatting | Works out of the box — no pushprep-specific config file required |
| Usability | Respects existing `.prettierrc` | Never overrides project's existing formatter preferences |
| Maintainability | Single-responsibility modules | Each of the 5 source files has one clear, isolated concern |
| Package size | Minimal dependencies | Only 6 runtime dependencies; no bloated transitive dep chains |

---

## 9. Publishing & Distribution

### 9.1 npm Publishing Checklist

1. Confirm `package.json` has: `name`, `version`, `description`, `keywords`, `bin`, `type: module`, `engines`
2. Add `.npmignore` to exclude: `node_modules/`, `.env`, `*.log`, `.DS_Store`
3. Run `npm pack --dry-run` to inspect exactly what files will be published
4. Run `npm login` to authenticate
5. Run `npm publish`
6. Verify: `npm install -g pushprep` on a clean machine
7. Verify: `pushprep --version` prints correctly
8. Verify: `pushprep --help` prints correctly

### 9.2 Versioning Strategy (Semantic Versioning)

| Bump | When | Example |
|---|---|---|
| **Patch** `x.x.1` | Bug fixes, error message improvements, minor UX tweaks | `1.0.1` — fix quota error detection |
| **Minor** `x.1.0` | New backward-compatible features | `1.1.0` — add OpenAI as alternative to Gemini |
| **Major** `2.0.0` | Breaking changes to CLI interface or behavior | `2.0.0` — replace prompt library |

### 9.3 `.npmignore`

```
node_modules/
.env
*.log
.DS_Store
```

---

## 10. Future Roadmap (Post v1.0)

| Priority | Feature | Target Version | Description |
|---|---|---|---|
| P1 | ESLint integration | v1.1 | Run `eslint --fix` on changed files before Prettier |
| P1 | `--push` flag | v1.1 | Optional flag to also run `git push` after committing |
| P1 | Multiple AI providers | v1.1 | Allow choosing between Gemini, OpenAI GPT-4o, or Anthropic Claude |
| P2 | Commit history learning | v1.2 | Analyze last 20 commits to match team's existing commit style |
| P2 | Branch awareness | v1.2 | Include current branch name in Gemini prompt for better scope inference |
| P2 | Diff preview | v1.2 | Show condensed diff summary before the AI generation step |
| P3 | Team config file | v2.0 | Shared `.pushpreprc` committed to the repo for team-wide settings |
| P3 | Git hooks integration | v2.0 | Auto-run pushprep as a pre-push hook via husky or lefthook |

---

## 11. Success Metrics

### 11.1 Launch Goals (First 30 Days)

| Metric | Target |
|---|---|
| npm weekly downloads | 500+ / week |
| GitHub stars | 50+ |
| Zero critical bugs | No unhandled crashes reported |
| Documentation completeness | README covers 100% of features and setup |

### 11.2 Pre-Launch Quality Checklist

- [ ] Every error scenario in Section 5 manually tested
- [ ] Full workflow tested on at least 3 different real projects
- [ ] Package installs cleanly from npm on a fresh machine
- [ ] `pushprep config --key` + `pushprep` works end-to-end from scratch
- [ ] All 5 source files pass ESLint with zero errors
- [ ] `npm pack --dry-run` output inspected — no sensitive files included

---

## 12. Appendix

### 12.1 Conventional Commits Quick Reference

| Type | When to Use | Example |
|---|---|---|
| `feat` | New feature | `feat(auth): add Google OAuth login` |
| `fix` | Bug fix | `fix(api): handle null response from payments endpoint` |
| `refactor` | Code change, no feature/fix | `refactor(utils): extract date formatting logic` |
| `style` | Formatting only, no logic change | `style(button): apply Prettier formatting` |
| `docs` | Documentation only | `docs(readme): add troubleshooting section` |
| `chore` | Build process or tooling | `chore(deps): update prettier to 3.3.0` |
| `test` | Adding or updating tests | `test(auth): add unit tests for token refresh` |
| `perf` | Performance improvement | `perf(images): lazy load product thumbnails` |
| `ci` | CI/CD configuration | `ci(github): add Node 20 to test matrix` |

### 12.2 Key External Links

- **Get Gemini API Key (free):** https://aistudio.google.com/app/apikey
- **Conventional Commits spec:** https://www.conventionalcommits.org
- **Prettier programmatic API:** https://prettier.io/docs/en/api.html
- **simple-git docs:** https://github.com/steveukx/git-js
- **@clack/prompts docs:** https://github.com/natemoo-re/clack
- **npm publishing guide:** https://docs.npmjs.com/creating-and-publishing-packages

---

*pushprep PRD v1.0 — Built with intention. Shipped with confidence.*
