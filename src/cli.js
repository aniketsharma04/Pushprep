#!/usr/bin/env node

import { program } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import readline from "readline";

import {
  getActiveProviderId,
  setActiveProvider,
  resolveKey,
  getStoredKey,
  saveProviderKey,
  removeProviderKey,
  getStoredModel,
  setStoredModel,
  getTipsEnabled,
  setTipsEnabled,
  getConfigSummary,
  maskKey,
} from "./config.js";
import {
  isGitRepo,
  getAllChangedFiles,
  getChangeSets,
  stageAllFiles,
  stageSpecificFiles,
  unstageFilesSync,
  getStagedFiles,
  getDiff,
  getDiffStat,
  commitWithMessage,
  amendWithMessage,
  hasCommits,
  getLastCommitMessage,
  getLastCommitDiff,
  getLastCommitFiles,
  getCurrentBranch,
  pushCurrent,
} from "./git.js";
import { formatFiles } from "./formatter.js";
import { multiselectScrolling } from "./file-picker.js";
import {
  generateCommitMessages,
  checkModel,
  getProvider,
  listProviders,
  DEFAULT_PROVIDER,
} from "./ai.js";
import { maybeAutoUpdate } from "./update.js";

// ─── Resolve package version ────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

// ─── ASCII Banner ────────────────────────────────────────────────────────────
function printBanner() {
  console.log(
    chalk.bold.cyan(`
  ██████╗ ██╗   ██╗███████╗██╗  ██╗██████╗ ██████╗ ███████╗██████╗
  ██╔══██╗██║   ██║██╔════╝██║  ██║██╔══██╗██╔══██╗██╔════╝██╔══██╗
  ██████╔╝██║   ██║███████╗███████║██████╔╝██████╔╝█████╗  ██████╔╝
  ██╔═══╝ ██║   ██║╚════██║██╔══██║██╔═══╝ ██╔══██╗██╔══╝  ██╔═══╝
  ██║     ╚██████╔╝███████║██║  ██║██║     ██║  ██║███████╗██║
  ╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚══════╝╚═╝
`),
  );
  console.log(chalk.dim("  Format → Stage → AI Commit. All in one command.\n"));
}

// ─── Staging rollback ────────────────────────────────────────────────────────
// If pushprep stages files this run and the user then bails out abruptly
// (Ctrl+C anywhere before the commit is made), we undo that staging — an aborted
// run shouldn't silently leave the work it staged behind. We unstage exactly the
// files pushprep staged this run, so anything the user had staged beforehand and
// pushprep never touched is left alone. `stagedThisRun` holds those files while
// armed, and is null when there's nothing to undo (nothing staged yet, or
// already committed / deliberately kept).
let stagedThisRun = null;

function armStagingRollback(files) {
  stagedThisRun = Array.isArray(files) ? files.slice() : null;
}

function disarmStagingRollback() {
  stagedThisRun = null;
}

/**
 * Unstages exactly the files pushprep staged this run. Idempotent — the list is
 * cleared once used, so multiple cancel handlers firing for one exit never run
 * it twice. Returns the number of files reverted (0 if nothing was armed).
 */
function runStagingRollback() {
  if (!stagedThisRun || stagedThisRun.length === 0) {
    stagedThisRun = null;
    return 0;
  }
  const files = stagedThisRun;
  stagedThisRun = null;
  unstageFilesSync(files);
  return files.length;
}

// ─── Cancel helper ───────────────────────────────────────────────────────────
// Handles clack's Ctrl+C during a prompt (which resolves to a cancel symbol
// rather than raising SIGINT). Reverts this run's staging first so an abrupt
// cancel leaves the repo as pushprep found it.
function handleCancel(value) {
  if (p.isCancel(value)) {
    const n = runStagingRollback();
    p.cancel(
      n ? `Cancelled. Unstaged ${n} file(s) staged this run.` : "Cancelled.",
    );
    process.exit(0);
  }
}

// Ctrl+C anywhere other than an interactive prompt needs two nets:
//   • SIGINT — fires when the terminal is in cooked mode (e.g. between prompts).
//   • 'exit' — the bulletproof backstop. Ctrl+C during a clack spinner is caught
//     by clack's block() in RAW mode, which calls process.exit(0) directly and
//     never raises SIGINT. process.exit always fires 'exit', so the rollback
//     (synchronous, via execFileSync) runs there too. Idempotent with the others.
// Registered lazily from runPushPrep so setup/doctor/config are unaffected.
let cancelHandlersInstalled = false;
// Held so teardownCancelHandlers() can remove exactly this listener later.
let escapeListener = null;
function installCancelHandlers() {
  if (cancelHandlersInstalled) return;
  cancelHandlersInstalled = true;

  process.on("SIGINT", () => {
    const n = runStagingRollback();
    console.log(
      n
        ? chalk.yellow(`\n  Cancelled. Unstaged ${n} file(s) staged this run.`)
        : chalk.dim("\n  Cancelled."),
    );
    process.exit(130);
  });

  process.on("exit", () => {
    const n = runStagingRollback();
    if (n) {
      process.stdout.write(
        chalk.yellow(`  Unstaged ${n} file(s) staged this run.\n`),
      );
    }
  });

  // ESC anywhere before the commit cancels the run, mirroring Ctrl+C: stop and
  // unstage exactly what pushprep staged this run. clack only treats Ctrl+C as a
  // cancel and ignores ESC entirely, so we listen for the escape keypress
  // ourselves. (A future release will make ESC step *back* one prompt at a time
  // instead of exiting outright.) TTY-only — there are no keypresses to read
  // when input is piped.
  //
  // Do NOT unref() stdin here. While a prompt waits for input, stdin is the only
  // referenced handle keeping the event loop alive; unref'ing it makes Node
  // consider itself idle and exit mid-prompt, so the very first menu would
  // vanish and drop the user back at the shell. The listener is removed
  // explicitly by teardownCancelHandlers() once the run is done instead.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    escapeListener = (_str, key) => {
      if (key && key.name === "escape") {
        const n = runStagingRollback();
        console.log(
          n
            ? chalk.yellow(
                `\n  Cancelled. Unstaged ${n} file(s) staged this run.`,
              )
            : chalk.dim("\n  Cancelled."),
        );
        process.exit(0);
      }
    };
    process.stdin.on("keypress", escapeListener);
  }
}

// Releases stdin at the end of a successful run. Without this the keypress
// listener holds the event loop open and the CLI hangs after printing its outro.
// Only the ESC listener is torn down — the SIGINT and 'exit' nets stay armed.
function teardownCancelHandlers() {
  if (escapeListener) {
    process.stdin.removeListener("keypress", escapeListener);
    escapeListener = null;
  }
  if (process.stdin.isTTY && process.stdin.isRaw) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // Terminal already reset by clack — nothing to undo.
    }
  }
  process.stdin.pause();
}

// Deliberate "Don't commit — exit" path from the commit menu. When pushprep
// staged files this run, ask whether to keep them staged (default yes, the usual
// intent) or unstage them. When pushprep staged nothing (the user picked "Skip
// staging"), there's nothing of ours to undo, so just exit.
async function exitWithoutCommitting() {
  if (stagedThisRun && stagedThisRun.length) {
    const keep = await p.confirm({
      message: "Keep the files staged?",
      initialValue: true,
    });
    handleCancel(keep); // Ctrl+C here still reverts, via the armed rollback
    if (keep) {
      disarmStagingRollback();
      p.outro(
        chalk.cyan("Exited without committing. Your files are still staged."),
      );
    } else {
      const n = runStagingRollback();
      p.outro(chalk.cyan(`Exited without committing. Unstaged ${n} file(s).`));
    }
  } else {
    p.outro(
      chalk.cyan("Exited without committing. Your files are still staged."),
    );
  }
  process.exit(0);
}

// ─── File list printing ──────────────────────────────────────────────────────
// Prints a changed-file list, but never more than a screenful. An untracked
// build folder can expand into hundreds of paths (git status runs with -u, so
// directories are listed file by file); dumping all of them scrolls the banner
// and the rest of the run off the screen before the staging prompt even opens.
const FILE_LIST_LIMIT = 12;

function printFileList(files, limit = FILE_LIST_LIMIT) {
  for (const f of files.slice(0, limit)) {
    console.log(chalk.dim(`     • ${f}`));
  }
  if (files.length > limit) {
    console.log(chalk.dim(`     … and ${files.length - limit} more`));
  }
}

// ─── Subtle one-line tips ────────────────────────────────────────────────────
// Dim, single-line, shown only at key moments. Off via `pushprep config
// --tips off` or PUSHPREP_TIPS=0 so they never become noise.
function tip(message) {
  if (getTipsEnabled()) {
    console.log(chalk.dim(`  💡 ${message}`));
  }
}

// ─── Provider resolution ─────────────────────────────────────────────────────
// The active provider is: --provider flag > saved config > Gemini default.
function resolveProviderId(opts = {}) {
  const flag = opts.provider && String(opts.provider).trim().toLowerCase();
  return flag || getActiveProviderId() || DEFAULT_PROVIDER;
}

function resolveProvider(opts = {}) {
  return getProvider(resolveProviderId(opts));
}

/** Resolves a provider's key from its env vars, then the saved config. */
function keyForProvider(provider) {
  return resolveKey(provider.envKeys, provider.id);
}

// Ordered providers to try for one generation: the active provider first, then
// every OTHER key-based provider the user has a key for. This is what powers
// cross-provider fallback — if the active one hits its limit, pushprep moves to
// the next configured API instead of dropping to generic messages. Keyless
// providers (Ollama) join only when they're the active choice, never as an
// automatic fallback.
function buildProviderChain(active) {
  const others = listProviders().filter(
    (pr) =>
      pr.id !== active.id && pr.needsKey && !!resolveKey(pr.envKeys, pr.id),
  );
  return [active, ...others];
}

// ─── First-run / setup wizard ────────────────────────────────────────────────
// Interactive: pick a provider, drop in a key (unless it's keyless like Ollama),
// and save it as the active provider. Reused by `pushprep config` (no args) and
// auto-offered when a run finds no key.
async function runSetup() {
  p.intro(chalk.bold("pushprep setup"));

  // Provider picker — each option shows where to get that provider's key (or
  // that it's a keyless local one) right in the list, so you can go generate a
  // key without leaving the wizard.
  const currentId = getActiveProviderId();
  const providerChoice = await p.select({
    message: "Which AI provider do you want to use?",
    initialValue: currentId || DEFAULT_PROVIDER,
    options: listProviders().map((prov) => ({
      value: prov.id,
      label: prov.recommended
        ? `${prov.label} ${chalk.green("(Recommended)")}`
        : prov.label,
      hint: prov.needsKey
        ? `get a key: ${prov.keyUrl}`
        : "local · no key needed",
    })),
  });
  handleCancel(providerChoice);

  const provider = getProvider(providerChoice);
  setActiveProvider(provider.id);

  if (provider.needsKey) {
    // Show the key-generation link prominently before asking for the key.
    if (provider.keyUrl) {
      p.note(
        `Generate a ${provider.label} API key here, then paste it below:\n${chalk.cyan(provider.keyUrl)}`,
        "🔑 Get your API key",
      );
    }
    const existing = getStoredKey(provider.id);
    const key = await p.password({
      message: existing
        ? `${provider.label} API key (press enter to keep the saved one):`
        : `Paste your ${provider.label} API key:`,
      validate(value) {
        if (!value && existing) return; // keep existing
        if (!value || value.trim().length < 8)
          return "That key looks too short.";
      },
    });
    handleCancel(key);
    if (key && key.trim()) {
      saveProviderKey(provider.id, key.trim());
    }
    tip("Keys are stored locally in ~/.pushprep/config.json — never uploaded.");
  }

  // Optional model choice — every provider has a sensible default; press enter
  // to accept it, or type a specific model name.
  const currentModel = getStoredModel(provider.id);
  const modelAnswer = await p.text({
    message: `Model to use (enter for the default):`,
    placeholder: provider.defaultModel,
    initialValue: currentModel || "",
    defaultValue: "",
  });
  handleCancel(modelAnswer);
  if (modelAnswer && modelAnswer.trim()) {
    setStoredModel(provider.id, modelAnswer.trim());
  }

  // Keyless (Ollama): confirm the server is up and the chosen model is pulled,
  // so setup fails loudly now instead of at commit time.
  if (!provider.needsKey) {
    const spin = p.spinner();
    spin.start(`Checking ${provider.label}...`);
    const res = await provider.check({ model: getStoredModel(provider.id) });
    if (res.ok) {
      spin.stop(chalk.green(`${provider.label} reachable (${res.model}).`));
    } else {
      spin.stop(chalk.yellow(`${provider.label}: ${res.message}`));
    }
  }

  const activeModel = getStoredModel(provider.id) || provider.defaultModel;
  p.outro(
    chalk.green(
      `✅ Using ${provider.label} (${activeModel}). Run ${chalk.cyan("pushprep")} to get started.`,
    ),
  );
}

// ─── Auto-update gate ────────────────────────────────────────────────────────
// Best-effort: keeps a global install current, then re-execs onto the new
// version. A no-op (and instant) for dev checkouts, CI, when up to date, or when
// PUSHPREP_NO_UPDATE=1. Never throws.
async function autoUpdateGate() {
  const spin = p.spinner();
  let spinning = false;
  await maybeAutoUpdate(pkg.version, ({ phase, version }) => {
    if (phase === "start") {
      spin.start(`Updating pushprep to v${version}...`);
      spinning = true;
    } else if (phase === "done") {
      spin.stop(chalk.green(`Updated to v${version} — relaunching...`));
    } else if (phase === "fail" && spinning) {
      spin.stop(
        chalk.yellow("Auto-update unavailable — continuing on this version."),
      );
    }
  });
}

// ─── Main Workflow ───────────────────────────────────────────────────────────
async function runPushPrep(opts = {}) {
  const isAmend = !!opts.amend;

  // Self-update before doing any work, so this run uses the newest version.
  await autoUpdateGate();

  printBanner();
  p.intro(chalk.bold("Starting your pre-push workflow..."));
  tip(
    `New to pushprep? Run ${chalk.cyan("pushprep --help")} to see every command.`,
  );

  // ── Guard: must be inside a git repo ──────────────────────────────────────
  const inRepo = await isGitRepo();
  if (!inRepo) {
    p.log.error("Not a git repository. Run pushprep inside a git project.");
    process.exit(1);
  }

  // Catch every abrupt-exit path (prompt cancel, SIGINT, spinner Ctrl+C) so any
  // staging we do this run is rolled back rather than silently left behind.
  installCancelHandlers();

  // ── Resolve the active AI provider + key ──────────────────────────────────
  const provider = resolveProvider(opts);
  let apiKey = keyForProvider(provider);

  // Keyless providers (Ollama) skip this entirely. Otherwise, if no key is set,
  // offer an inline one-question setup rather than dumping instructions.
  if (provider.needsKey && !apiKey) {
    p.log.warn(`No ${provider.label} API key found.`);
    const setupNow = await p.confirm({
      message: `Add your ${provider.label} key now?`,
      initialValue: true,
    });
    handleCancel(setupNow);
    if (!setupNow) {
      p.log.info(
        chalk.dim(
          `Run ${chalk.cyan("pushprep config")} to pick a provider and add a key.`,
        ),
      );
      process.exit(1);
    }
    const key = await p.password({
      message: `Paste your ${provider.label} API key:`,
      validate(v) {
        if (!v || v.trim().length < 8) return "That key looks too short.";
      },
    });
    handleCancel(key);
    apiKey = key.trim();
    saveProviderKey(provider.id, apiKey);
    setActiveProvider(provider.id);
    if (provider.keyUrl) tip(`Manage your key any time at ${provider.keyUrl}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1 — FORMAT
  // ═══════════════════════════════════════════════════════════════════════════
  const allChanged = await getAllChangedFiles();

  // A clean tree is a hard stop for a normal run, but valid for --amend
  // (rewording the previous commit needs no new changes).
  if (allChanged.length === 0 && !isAmend) {
    p.outro(chalk.green("Nothing to stage or commit. You're all clean! 🎉"));
    process.exit(0);
  }

  let formatted = [];
  let alreadyClean = [];
  let failed = [];

  if (allChanged.length > 0) {
    const formatSpinner = p.spinner();
    formatSpinner.start(
      `Running Prettier on ${allChanged.length} changed file(s)...`,
    );

    ({ formatted, alreadyClean, failed } = await formatFiles(allChanged));

    formatSpinner.stop(`Prettier done.`);
  }

  // Print per-file formatting results
  for (const f of formatted) {
    p.log.success(chalk.green(`Formatted: ${f}`));
  }
  for (const f of alreadyClean) {
    p.log.info(chalk.dim(`Already clean: ${f}`));
  }
  for (const f of failed) {
    p.log.warn(chalk.yellow(`⚠  Could not format: ${f}`));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — STATUS
  // ═══════════════════════════════════════════════════════════════════════════
  // getChangeSets classifies via the porcelain codes so a fully-staged file no
  // longer shows up under both "Unstaged" and "Already staged".
  const { unstaged, staged: alreadyStaged } = await getChangeSets();

  if (unstaged.length > 0) {
    console.log("");
    console.log(chalk.bold(`  📂 Unstaged files (${unstaged.length}):`));
    printFileList(unstaged);
  }

  if (alreadyStaged.length > 0) {
    console.log("");
    console.log(chalk.bold(`  ✅ Already staged (${alreadyStaged.length}):`));
    printFileList(alreadyStaged);
  }

  console.log("");

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3 — STAGE
  // ═══════════════════════════════════════════════════════════════════════════
  if (unstaged.length > 0) {
    const stagingChoice = await p.select({
      message: "How do you want to stage your files?",
      options: [
        { value: "all", label: "Stage all files", hint: "git add ." },
        {
          value: "specific",
          label: "Choose specific files",
          hint: "Pick from the list",
        },
        {
          value: "skip",
          label: "Skip staging",
          hint: "Use already staged files",
        },
      ],
    });
    handleCancel(stagingChoice);

    if (stagingChoice === "all") {
      await stageAllFiles();
      // Arm rollback: an abrupt cancel / revert unstages exactly the files this
      // run staged (every previously-unstaged file).
      armStagingRollback(unstaged);
      p.log.success(chalk.green("All files staged (git add .)"));
    } else if (stagingChoice === "specific") {
      const fileOptions = unstaged.map((f) => ({ value: f, label: f }));

      tip("↑↓ to move · space to select · a to toggle all · enter to confirm");
      // Scrolling picker, not p.multiselect: clack's renders every option in one
      // frame, which breaks the redraw once the list outgrows the terminal.
      const chosen = await multiselectScrolling({
        message: "Select files to stage:",
        options: fileOptions,
        required: true,
      });
      handleCancel(chosen);

      await stageSpecificFiles(chosen);
      armStagingRollback(chosen);
      p.log.success(chalk.green(`Staged ${chosen.length} file(s)`));
    } else {
      p.log.info(chalk.dim("Skipping staging — using already staged files."));
    }
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const staged = await getStagedFiles();

  if (isAmend) {
    if (!(await hasCommits())) {
      p.log.error("No previous commit to amend. Make a commit first.");
      process.exit(1);
    }
    p.log.info(
      chalk.dim("Amend mode — this will rewrite your previous commit."),
    );
  } else if (staged.length === 0) {
    p.log.warn(
      "No staged files found. Stage your files first, then run pushprep again.",
    );
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4 — AI COMMIT
  // ═══════════════════════════════════════════════════════════════════════════
  // In amend mode we describe the previous commit's diff (plus any newly staged
  // changes that will be folded in). Otherwise we describe the staged diff.
  let diff;
  let filesForPrompt;
  if (isAmend) {
    const lastDiff = await getLastCommitDiff();
    const stagedDiff = await getDiff();
    diff = stagedDiff ? `${lastDiff}\n${stagedDiff}` : lastDiff;
    filesForPrompt = [...new Set([...staged, ...(await getLastCommitFiles())])];
  } else {
    diff = await getDiff();
    filesForPrompt = staged;
  }
  const diffStat = await getDiffStat();

  // Generation + selection loop — supports 🔄 Regenerate for fresh suggestions.
  // The provider chain enables cross-provider fallback: if the active provider
  // fails, pushprep auto-switches to another configured provider, only using
  // local messages when every one is exhausted.
  const preferredModel =
    opts.model ||
    process.env.PUSHPREP_MODEL ||
    getStoredModel(provider.id) ||
    undefined;
  const genChain = buildProviderChain(provider).map((pr) => ({
    id: pr.id,
    apiKey: pr.needsKey ? keyForProvider(pr) : null,
    model:
      (pr.id === provider.id ? preferredModel : undefined) ||
      getStoredModel(pr.id) ||
      undefined,
  }));
  let finalSubject;
  let finalBody;
  let attempt = 0;

  while (finalSubject === undefined) {
    if (attempt === 0) {
      tip(
        `While that runs — ${chalk.cyan("pushprep --help")} lists every command & flag.`,
      );
    }
    const aiSpinner = p.spinner();
    aiSpinner.start(
      attempt === 0
        ? `Asking ${provider.label} to generate commit messages...`
        : "Regenerating commit messages...",
    );

    const switched = [];
    const {
      messages,
      usedFallback,
      provider: usedProviderId,
    } = await generateCommitMessages(diff, filesForPrompt, diffStat, {
      chain: genChain,
      // Nudge the temperature up on regenerate so fresh options differ.
      temperature: attempt === 0 ? undefined : 0.7,
      onSwitch: ({ from, to, kind }) => {
        switched.push({ from, to });
        const why =
          kind === "quota"
            ? "reached its limit"
            : kind === "invalidKey"
              ? "key was rejected"
              : "was unavailable";
        // Update the live spinner so the switch is visible as it happens.
        aiSpinner.message(`${from.label} ${why} — switching to ${to.label}...`);
      },
    });
    attempt++;

    const usedProvider = getProvider(usedProviderId);
    if (usedFallback) {
      aiSpinner.stop(chalk.yellow("Using local fallback commit messages."));
      tip("Run 'pushprep doctor' to check your AI setup.");
    } else if (switched.length > 0) {
      aiSpinner.stop(
        chalk.green(`Got 3 suggestions from ${usedProvider.label}. ✨`),
      );
      p.log.info(
        chalk.yellow(
          `${switched[0].from.label} was unavailable — used ${usedProvider.label} instead.`,
        ),
      );
      tip(
        `Make ${usedProvider.label} your default: pushprep config --provider ${usedProviderId}`,
      );
    } else {
      aiSpinner.stop(chalk.green("Got 3 commit message suggestions! ✨"));
    }

    // Print each suggestion in FULL (subject + complete body) above the menu so
    // the whole message is readable while choosing — the select row itself can
    // only fit one line, which truncates longer bodies.
    console.log("");
    messages.forEach((msg, i) => {
      console.log(chalk.cyan.bold(`  ${i + 1}. ${msg.subject}`));
      if (msg.body) {
        for (const line of msg.body.split("\n")) {
          console.log(chalk.dim(`     ${line}`));
        }
      }
      console.log("");
    });

    // The menu labels mirror the numbered blocks above; no truncated hint needed.
    const commitOptions = messages.map((msg, i) => ({
      value: String(i),
      label: `${i + 1}. ${msg.subject}`,
    }));
    commitOptions.push({
      value: "__regenerate__",
      label: "🔄 Regenerate suggestions",
      hint: "Get 3 new options",
    });
    commitOptions.push({
      value: "__custom__",
      label: "✏️  Write my own commit message",
      hint: "",
    });
    commitOptions.push({
      value: "__exit__",
      label: "🚪 Don't commit — exit",
      hint: "Stop here without committing",
    });

    const chosen = await p.select({
      message: "Choose your commit message (full text shown above):",
      options: commitOptions,
    });
    handleCancel(chosen);

    if (chosen === "__regenerate__") {
      continue; // loop and generate a fresh set
    }

    if (chosen === "__exit__") {
      // Deliberate "I don't want to commit" exit. Unlike an abrupt Ctrl+C, the
      // user is choosing to stop, so we let them decide the staged files' fate —
      // defaulting to keeping them (that's usually the intent). Only ask when
      // pushprep actually staged something this run.
      await exitWithoutCommitting();
      // exitWithoutCommitting() always exits the process.
    }

    if (chosen === "__custom__") {
      const customSubject = await p.text({
        message: "Subject line (type(scope): description):",
        placeholder: "feat(scope): describe your change",
        validate(value) {
          if (!value || value.trim().length === 0)
            return "Subject cannot be empty.";
          if (value.length > 100)
            return "Subject must be 100 characters or fewer.";
        },
      });
      handleCancel(customSubject);
      finalSubject = customSubject.trim();

      const customBody = await p.text({
        message: "Body (optional — explain what and why, blank to skip):",
        placeholder: "",
        defaultValue: "",
      });
      handleCancel(customBody);
      finalBody = (customBody || "").trim();
    } else {
      const picked = messages[Number(chosen)];
      finalSubject = picked.subject;
      finalBody = picked.body;
    }
  }

  // Preview + confirm loop. The user can commit as-is, edit the subject/body
  // inline (pre-filled so they only tweak what they want), or cancel.
  const verb = isAmend ? "amend" : "commit";
  while (true) {
    const finalMessage = finalBody
      ? `${finalSubject}\n\n${finalBody}`
      : finalSubject;

    console.log("");
    console.log(chalk.dim(`  ─── ${isAmend ? "Amend" : "Commit"} preview ───`));
    console.log(chalk.bold(`  ${finalSubject}`));
    if (finalBody) {
      console.log("");
      for (const line of finalBody.split("\n")) {
        console.log(chalk.dim(`  ${line}`));
      }
    }
    console.log(chalk.dim("  ──────────────────────"));
    console.log("");

    const action = await p.select({
      message: `Ready to ${verb}?`,
      options: [
        {
          value: "commit",
          label: isAmend
            ? "Amend with this message"
            : "Commit with this message",
          hint: "",
        },
        {
          value: "edit",
          label: `Edit before ${verb}ting`,
          hint: "Tweak the subject / body",
        },
        {
          value: "cancel",
          label: "Cancel",
          hint: "Keep files staged, don't commit",
        },
      ],
    });
    handleCancel(action);

    if (action === "cancel") {
      // Deliberate cancel (not Ctrl+C) — keep the staged files, matching the
      // option's hint, so don't run the rollback.
      disarmStagingRollback();
      p.cancel("Cancelled. Your staged files are still staged.");
      process.exit(0);
    }

    if (action === "edit") {
      const editedSubject = await p.text({
        message: "Subject line (type(scope): description):",
        initialValue: finalSubject,
        validate(value) {
          if (!value || value.trim().length === 0)
            return "Subject cannot be empty.";
          if (value.length > 100)
            return "Subject must be 100 characters or fewer.";
        },
      });
      handleCancel(editedSubject);
      finalSubject = editedSubject.trim();

      const editedBody = await p.text({
        message: "Body (optional — explain what and why, blank to skip):",
        initialValue: finalBody,
        defaultValue: "",
      });
      handleCancel(editedBody);
      finalBody = (editedBody || "").trim();

      // Loop back to re-preview the edited message before committing.
      continue;
    }

    // action === "commit" — the commit consumes the staging, so there's nothing
    // left to roll back if the user cancels the push prompt below.
    if (isAmend) {
      await amendWithMessage(finalMessage);
      p.log.success(chalk.green(`Amended: "${finalSubject}"`));
    } else {
      await commitWithMessage(finalMessage);
      p.log.success(chalk.green(`Committed: "${finalSubject}"`));
    }
    disarmStagingRollback();
    break;
  }

  // ── Optional push ───────────────────────────────────────────────────────────
  const pushed = await maybePush(opts, isAmend);

  if (pushed) {
    p.outro(chalk.bold.cyan("🚀 All done! Your commit is pushed."));
  } else {
    p.outro(
      chalk.bold.cyan("🚀 All done! Run git push whenever you're ready."),
    );
  }

  // Release stdin so the process can exit instead of waiting on the ESC listener.
  teardownCancelHandlers();
}

// ─── Push helper ─────────────────────────────────────────────────────────────
async function maybePush(opts, isAmend) {
  let doPush = !!opts.push;

  if (!doPush) {
    const branch = await getCurrentBranch();
    const answer = await p.confirm({
      message: branch ? `Push ${branch} to remote now?` : "Push to remote now?",
      initialValue: false,
    });
    handleCancel(answer);
    doPush = answer;
  }

  if (!doPush) return false;

  const spin = p.spinner();
  spin.start("Pushing to remote...");
  const res = await pushCurrent();

  if (res.ok) {
    spin.stop(chalk.green(`Pushed ${res.message} to remote. 🚀`));
    return true;
  }

  spin.stop(chalk.yellow("Push failed."));
  p.log.warn(`Could not push: ${res.message}`);
  if (isAmend) {
    p.log.info(
      chalk.dim(
        "If this commit was already pushed, amending rewrote history — you'd need 'git push --force-with-lease' manually.",
      ),
    );
  }
  return false;
}

// ─── Doctor ──────────────────────────────────────────────────────────────────
function doctorModelFix(r, provider) {
  // Keyless providers (Ollama) already return actionable messages ("pull it",
  // "start ollama serve") — surface those directly.
  if (!provider.needsKey) return r.message;

  const keyUrl = provider.keyUrl;
  switch (r.kind) {
    case "quota":
      return `Quota exhausted. Use a new key (pushprep config --key ...) or wait for it to reset.${keyUrl ? ` Keys: ${keyUrl}` : ""}`;
    case "invalidKey":
      return `API key rejected.${keyUrl ? ` Verify it at ${keyUrl}, then` : " Then"} re-run pushprep config --key.`;
    case "modelNotFound":
      return "No known model was reachable. Update pushprep, or pass --model with a current model name.";
    case "badRequest":
      return "The model rejected the request — your API key is fine. Update pushprep, or pass --model with a current model name.";
    case "timeout":
      return "The API timed out. Check your internet connection and try again.";
    default:
      return `Could not reach the model: ${r.message}`;
  }
}

async function runDoctor(opts = {}) {
  console.log(chalk.bold.cyan("\n  pushprep doctor\n"));

  const provider = resolveProvider(opts);
  const results = [];

  // Node.js version
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  results.push({
    ok: nodeMajor >= 18,
    label: `Node.js ${process.versions.node}`,
    fix: "pushprep needs Node.js >= 18. Upgrade at https://nodejs.org",
  });

  // Git repository
  const inRepo = await isGitRepo();
  results.push({
    ok: inRepo,
    label: inRepo ? "Inside a git repository" : "Not a git repository",
    fix: "Run pushprep inside a git project (or run git init).",
  });

  // Active provider (informational)
  results.push({
    ok: true,
    label: `AI provider: ${provider.label}`,
    fix: "",
  });

  // API key — only key-based providers need one.
  let apiKey = null;
  if (provider.needsKey) {
    apiKey = keyForProvider(provider);
    results.push({
      ok: !!apiKey,
      label: apiKey
        ? `${provider.label} API key found`
        : `No ${provider.label} API key`,
      fix: `Set one with: pushprep config (or --key). ${provider.keyUrl ? `Get a key at ${provider.keyUrl}.` : ""}`,
    });
  }

  // Model reachability — run for keyless providers, or when a key is present.
  if (!provider.needsKey || apiKey) {
    const spin = p.spinner();
    spin.start(`Checking ${provider.label} reachability...`);
    const modelResult = await checkModel(
      apiKey,
      opts.model || getStoredModel(provider.id),
      provider.id,
    );
    spin.stop(
      modelResult.ok
        ? chalk.green("Model reachable.")
        : chalk.yellow("Model check failed."),
    );
    results.push({
      ok: modelResult.ok,
      label: modelResult.ok
        ? `Model reachable (${modelResult.model})`
        : `Model unreachable (${modelResult.model})`,
      fix: doctorModelFix(modelResult, provider),
    });
  }

  console.log("");
  for (const r of results) {
    const icon = r.ok ? chalk.green("✅") : chalk.red("❌");
    console.log(`  ${icon}  ${r.label}`);
    if (!r.ok) console.log(chalk.dim(`      → ${r.fix}`));
  }
  console.log("");

  if (results.every((r) => r.ok)) {
    console.log(
      chalk.green.bold("  All checks passed — pushprep is ready. 🚀\n"),
    );
    process.exit(0);
  } else {
    console.log(chalk.yellow("  Some checks failed — see the fixes above.\n"));
    process.exit(1);
  }
}

// ─── Commander Setup ─────────────────────────────────────────────────────────
program
  .name("pushprep")
  .version(pkg.version, "-v, --version", "Print the installed version number")
  .description("Format → Stage → AI Commit. All in one command.")
  // Hide commander's auto-generated "Commands:" list — every command is shown,
  // with a description, in the curated "Commands" block below instead.
  .configureHelp({ visibleCommands: () => [] })
  .addHelpText(
    "after",
    `
Commands:
  $ pushprep                          Run the full workflow
  $ pushprep --push                   Run the workflow, then push
  $ pushprep --amend                  Reword the previous commit's message
  $ pushprep --provider claude        Use a specific provider for this run
  $ pushprep --model <name>           Use a specific model for this run
  $ pushprep setup                    Pick a provider and add a key (wizard)
  $ pushprep doctor                   Diagnose git / provider / model setup
  $ pushprep config --show            Show the active model & all providers
  $ pushprep config --provider <name> Switch the active provider
  $ pushprep config --model <name>    Set the model for the active provider
  $ pushprep config --key <key>       Save an API key for the active provider

Providers: gemini (default), claude, openai, ollama (local · no key).
Set up any of them with: pushprep setup
`,
  );

// Shared flags for the workflow commands (default + `run`).
function addWorkflowOptions(cmd) {
  return cmd
    .option(
      "-P, --provider <name>",
      "AI provider for this run (gemini, claude, openai, ollama)",
    )
    .option(
      "-m, --model <name>",
      "Override the AI model (also settable via PUSHPREP_MODEL)",
    )
    .option("--push", "Push to the remote after committing (no prompt)")
    .option(
      "--amend",
      "Rewrite the previous commit's message instead of creating a new commit",
    );
}

// Default action — run full workflow.
// optsWithGlobals() merges options that commander routed to the root program
// (shared flags like --provider are declared on both root and subcommands, so
// the value can land on the root) — without it, subcommands see an empty object.
addWorkflowOptions(program)
  .option("--config", "Open the interactive provider & key setup wizard")
  .action((opts, command) => {
    const merged = command.optsWithGlobals();
    // `pushprep --config` is a convenience alias for the setup wizard, same as
    // `pushprep setup` / `pushprep config` with no other flags.
    if (merged.config) return runSetup();
    return runPushPrep(merged);
  });

// Explicit alias: pushprep run
addWorkflowOptions(
  program.command("run").description("Explicit alias — runs the full workflow"),
).action((opts, command) => runPushPrep(command.optsWithGlobals()));

// pushprep doctor — diagnose setup problems
program
  .command("doctor")
  .description(
    "Check your environment: git, provider key, and model reachability",
  )
  .option(
    "-P, --provider <name>",
    "Provider to diagnose (gemini, claude, openai, ollama)",
  )
  .option("-m, --model <name>", "Model to test reachability against")
  .action((opts, command) => runDoctor(command.optsWithGlobals()));

// pushprep setup — interactive provider + key wizard
program
  .command("setup")
  .description("Pick an AI provider and add its key (interactive)")
  .action(() => runSetup());

// Full config snapshot for `pushprep config --show`.
function printConfigSummary() {
  const s = getConfigSummary();
  const activeId = s.provider || DEFAULT_PROVIDER;
  const activeProvider = getProvider(activeId);
  // The model a run would actually use: the saved override, else the default.
  const activeModel = s.models[activeId] || activeProvider.defaultModel;
  console.log(chalk.bold("\n  pushprep config\n"));
  console.log(`  Active provider : ${chalk.cyan(activeProvider.label)}`);
  console.log(`  Active model    : ${chalk.cyan(activeModel)}`);
  console.log(
    `  Tips            : ${s.tips ? chalk.green("on") : chalk.dim("off")}`,
  );
  console.log("");
  console.log(chalk.bold("  Providers:"));
  for (const prov of listProviders()) {
    const key = s.keys[prov.id];
    const model = s.models[prov.id];
    const keyStr = prov.needsKey
      ? key
        ? chalk.green(maskKey(key))
        : chalk.dim("no key")
      : chalk.dim("no key needed");
    const active = prov.id === activeId ? chalk.cyan("  ← active") : "";
    const modelStr = model ? chalk.dim(`  model: ${model}`) : "";
    console.log(`    ${prov.label.padEnd(18)} ${keyStr}${modelStr}${active}`);
  }
  console.log("");
  console.log(chalk.bold("  Manage:"));
  console.log(
    chalk.dim("    Switch active provider   pushprep config --provider <name>"),
  );
  console.log(
    chalk.dim("    Use one for a single run pushprep --provider <name>"),
  );
  console.log(
    chalk.dim("    Change a provider model  pushprep config --model <name>"),
  );
  console.log("");
  console.log(
    chalk.dim(
      "  If your active provider hits its limit, pushprep auto-switches to another configured one.",
    ),
  );
  console.log(chalk.dim(`  Config: ${s.configPath}\n`));
}

// pushprep config — providers, keys, models, and tips. No flags → wizard.
program
  .command("config")
  .description("Configure providers, keys, models, and tips")
  .option(
    "-P, --provider <name>",
    "Switch the active provider, or scope --key/--model/--remove to it",
  )
  .option("--key <api_key>", "Save/update the API key for the target provider")
  .option("--model <name>", "Set the default model for the target provider")
  .option("--show", "Show saved providers, models, and settings")
  .option("--remove", "Remove the target provider's saved key")
  .option("--tips <on|off>", "Turn the subtle one-line UI tips on or off")
  .action(async (opts, command) => {
    opts = command.optsWithGlobals();
    // Target for key/model/remove: --provider, else the active provider.
    const targetId =
      (opts.provider && opts.provider.trim().toLowerCase()) ||
      getActiveProviderId() ||
      DEFAULT_PROVIDER;
    const target = getProvider(targetId);
    let didSomething = false;

    if (opts.provider) {
      setActiveProvider(target.id);
      console.log(chalk.green(`\n  ✅ Active provider: ${target.label}`));
      if (target.needsKey && !getStoredKey(target.id) && !opts.key) {
        console.log(
          chalk.dim(
            "  No key saved yet — add one with: pushprep config --key <key>  (or: pushprep setup)",
          ),
        );
      }
      didSomething = true;
    }

    if (opts.key) {
      saveProviderKey(target.id, opts.key.trim());
      console.log(chalk.green(`\n  ✅ Saved ${target.label} API key.`));
      didSomething = true;
    }

    if (opts.model) {
      setStoredModel(target.id, opts.model.trim());
      console.log(
        chalk.green(
          `\n  ✅ ${target.label} model set to ${opts.model.trim()}.`,
        ),
      );
      didSomething = true;
    }

    if (opts.remove) {
      removeProviderKey(target.id);
      console.log(chalk.yellow(`\n  🗑️  Removed ${target.label} API key.`));
      didSomething = true;
    }

    if (opts.tips !== undefined) {
      const on = /^(on|true|1|yes)$/i.test(String(opts.tips));
      setTipsEnabled(on);
      console.log(chalk.green(`\n  ✅ Tips ${on ? "enabled" : "disabled"}.`));
      didSomething = true;
    }

    if (opts.show) {
      printConfigSummary();
      didSomething = true;
    }

    // No flags → launch the interactive wizard.
    if (!didSomething) {
      await runSetup();
    }
  });

program.parse(process.argv);
