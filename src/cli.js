#!/usr/bin/env node

import { program } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

import { saveApiKey, getApiKey, removeApiKey, showConfig } from "./config.js";
import {
  isGitRepo,
  getAllChangedFiles,
  getChangeSets,
  stageAllFiles,
  stageSpecificFiles,
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
import { generateCommitMessages, checkModel } from "./ai.js";

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

// ─── Cancel helper ───────────────────────────────────────────────────────────
function handleCancel(value) {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}

// ─── Main Workflow ───────────────────────────────────────────────────────────
async function runPushPrep(opts = {}) {
  const isAmend = !!opts.amend;

  printBanner();
  p.intro(chalk.bold("Starting your pre-push workflow..."));

  // ── Guard: must be inside a git repo ──────────────────────────────────────
  const inRepo = await isGitRepo();
  if (!inRepo) {
    p.log.error("Not a git repository. Run pushprep inside a git project.");
    process.exit(1);
  }

  // ── Guard: must have an API key ────────────────────────────────────────────
  const apiKey = getApiKey();
  if (!apiKey) {
    p.log.error(
      "No Gemini API key found.\n\n" +
        "  Run the following command to set it up:\n" +
        chalk.cyan("    pushprep config --key YOUR_GEMINI_API_KEY") +
        "\n\n  Get a free key at: " +
        chalk.cyan("https://aistudio.google.com/app/apikey"),
    );
    process.exit(1);
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
    for (const f of unstaged) {
      console.log(chalk.dim(`     • ${f}`));
    }
  }

  if (alreadyStaged.length > 0) {
    console.log("");
    console.log(chalk.bold(`  ✅ Already staged (${alreadyStaged.length}):`));
    for (const f of alreadyStaged) {
      console.log(chalk.dim(`     • ${f}`));
    }
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
      p.log.success(chalk.green("All files staged (git add .)"));
    } else if (stagingChoice === "specific") {
      const fileOptions = unstaged.map((f) => ({ value: f, label: f }));

      const chosen = await p.multiselect({
        message: "Select files to stage:",
        options: fileOptions,
        required: true,
      });
      handleCancel(chosen);

      await stageSpecificFiles(chosen);
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
  let finalSubject;
  let finalBody;
  let attempt = 0;

  while (finalSubject === undefined) {
    const aiSpinner = p.spinner();
    aiSpinner.start(
      attempt === 0
        ? "Asking Gemini AI to generate commit messages..."
        : "Regenerating commit messages...",
    );

    const { messages, usedFallback } = await generateCommitMessages(
      diff,
      filesForPrompt,
      apiKey,
      diffStat,
      {
        model: opts.model,
        // Nudge the temperature up on regenerate so fresh options differ.
        temperature: attempt === 0 ? undefined : 0.7,
      },
    );
    attempt++;

    if (usedFallback) {
      aiSpinner.stop(chalk.yellow("Using local fallback commit messages."));
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

    const chosen = await p.select({
      message: "Choose your commit message (full text shown above):",
      options: commitOptions,
    });
    handleCancel(chosen);

    if (chosen === "__regenerate__") {
      continue; // loop and generate a fresh set
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

    // action === "commit"
    if (isAmend) {
      await amendWithMessage(finalMessage);
      p.log.success(chalk.green(`Amended: "${finalSubject}"`));
    } else {
      await commitWithMessage(finalMessage);
      p.log.success(chalk.green(`Committed: "${finalSubject}"`));
    }
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
function doctorModelFix(r) {
  switch (r.kind) {
    case "quota":
      return "Quota exhausted. Use a new key (pushprep config --key ...) or wait for it to reset.";
    case "invalidKey":
      return "API key rejected. Verify it at https://aistudio.google.com/app/apikey, then re-run pushprep config --key.";
    case "modelNotFound":
      return "No known model was reachable. Update pushprep, or pass --model with a current model name.";
    case "timeout":
      return "The API timed out. Check your internet connection and try again.";
    default:
      return `Could not reach the model: ${r.message}`;
  }
}

async function runDoctor(opts = {}) {
  console.log(chalk.bold.cyan("\n  pushprep doctor\n"));

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

  // API key
  const apiKey = getApiKey();
  results.push({
    ok: !!apiKey,
    label: apiKey ? "Gemini API key found" : "No Gemini API key",
    fix: "Set one with: pushprep config --key YOUR_GEMINI_API_KEY (or the GEMINI_API_KEY env var).",
  });

  // Model reachability (only worth checking if a key exists)
  if (apiKey) {
    const spin = p.spinner();
    spin.start("Checking model reachability...");
    const modelResult = await checkModel(apiKey, opts.model);
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
      fix: doctorModelFix(modelResult),
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
  .addHelpText(
    "after",
    `
Examples:
  $ pushprep                         Run the full workflow
  $ pushprep --push                  Run the workflow, then push
  $ pushprep --amend                 Rewrite the previous commit's message
  $ pushprep --model gemini-2.0-flash  Use a specific AI model
  $ pushprep doctor                  Diagnose git / API key / model setup
  $ pushprep config --key API_KEY    Save your Gemini API key
  $ pushprep config --show           Show saved API key (masked)
  $ pushprep config --remove         Delete the saved API key

Get a free Gemini API key at: https://aistudio.google.com/app/apikey
`,
  );

// Shared flags for the workflow commands (default + `run`).
function addWorkflowOptions(cmd) {
  return cmd
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

// Default action — run full workflow
addWorkflowOptions(program).action((opts) => runPushPrep(opts));

// Explicit alias: pushprep run
addWorkflowOptions(
  program.command("run").description("Explicit alias — runs the full workflow"),
).action((opts) => runPushPrep(opts));

// pushprep doctor — diagnose setup problems
program
  .command("doctor")
  .description("Check your environment: git, API key, and model reachability")
  .option("-m, --model <name>", "Model to test reachability against")
  .action((opts) => runDoctor(opts));

// pushprep config
const configCmd = program
  .command("config")
  .description("Manage your Gemini API key");

configCmd
  .option("--key <api_key>", "Save or update the Gemini API key")
  .option("--show", "Display masked API key and config file path")
  .option("--remove", "Delete the saved API key")
  .action((opts) => {
    if (opts.key) {
      saveApiKey(opts.key.trim());
      console.log(chalk.green("\n  ✅ API key saved successfully!"));
      console.log(chalk.dim("  Run pushprep to get started.\n"));
    } else if (opts.show) {
      const info = showConfig();
      if (info.hasKey) {
        console.log(chalk.bold("\n  pushprep config"));
        console.log(`  API Key : ${chalk.cyan(info.maskedKey)}`);
        console.log(`  Config  : ${chalk.dim(info.configPath)}\n`);
      } else {
        console.log(chalk.yellow("\n  No API key configured."));
        console.log(chalk.dim(`  Config path: ${info.configPath}`));
        console.log(
          chalk.dim("  Run: pushprep config --key YOUR_GEMINI_API_KEY\n"),
        );
      }
    } else if (opts.remove) {
      removeApiKey();
      console.log(chalk.yellow("\n  🗑️  API key removed."));
      console.log(
        chalk.dim("  Run pushprep config --key <key> to add a new one.\n"),
      );
    } else {
      console.log(chalk.dim("\n  Usage:"));
      console.log("    pushprep config --key <api_key>   Save API key");
      console.log("    pushprep config --show             Show saved key");
      console.log("    pushprep config --remove           Remove key\n");
    }
  });

program.parse(process.argv);
