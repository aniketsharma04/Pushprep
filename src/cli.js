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
  getGitStatus,
  stageAllFiles,
  stageSpecificFiles,
  getStagedFiles,
  getDiff,
  getDiffStat,
  commitWithMessage,
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

  if (allChanged.length === 0) {
    p.outro(chalk.green("Nothing to stage or commit. You're all clean! 🎉"));
    process.exit(0);
  }

  const formatSpinner = p.spinner();
  formatSpinner.start(
    `Running Prettier on ${allChanged.length} changed file(s)...`,
  );

  const { formatted, alreadyClean, failed } = await formatFiles(allChanged);

  formatSpinner.stop(`Prettier done.`);

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
  const status = await getGitStatus();

  const unstaged = [...status.modified, ...status.not_added, ...status.deleted];

  const alreadyStaged = [...status.staged, ...status.created];

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

  // ── Validate: something must be staged ────────────────────────────────────
  const staged = await getStagedFiles();
  if (staged.length === 0) {
    p.log.warn(
      "No staged files found. Stage your files first, then run pushprep again.",
    );
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4 — AI COMMIT
  // ═══════════════════════════════════════════════════════════════════════════
  const diff = await getDiff();
  const diffStat = await getDiffStat();

  const aiSpinner = p.spinner();
  aiSpinner.start("Asking Gemini AI to generate commit messages...");

  const { messages, usedFallback } = await generateCommitMessages(
    diff,
    staged,
    apiKey,
    diffStat,
    { model: opts.model },
  );

  if (usedFallback) {
    aiSpinner.stop(chalk.yellow("Using local fallback commit messages."));
  } else {
    aiSpinner.stop(chalk.green("Got 3 commit message suggestions! ✨"));
  }

  // Build select options: 3 AI messages + write custom.
  // Each AI entry is indexed; we resolve the full subject+body after selection.
  // Hint shows a body preview so the user can see at-a-glance whether a body
  // was actually generated (catches silent empty-body regressions early).
  const commitOptions = messages.map((msg, i) => {
    const firstBodyLine = (msg.body || "").split("\n")[0] || "";
    const preview = firstBodyLine
      ? firstBodyLine.length > 70
        ? firstBodyLine.slice(0, 67) + "…"
        : firstBodyLine
      : "(no body)";
    return {
      value: String(i),
      label: msg.subject,
      hint: preview,
    };
  });
  commitOptions.push({
    value: "__custom__",
    label: "✏️  Write my own commit message",
    hint: "",
  });

  const chosen = await p.select({
    message: "Choose your commit message:",
    options: commitOptions,
  });
  handleCancel(chosen);

  let finalSubject;
  let finalBody;

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

  // Preview + confirm loop. The user can commit as-is, edit the subject/body
  // inline (pre-filled so they only tweak what they want), or cancel.
  while (true) {
    const finalMessage = finalBody
      ? `${finalSubject}\n\n${finalBody}`
      : finalSubject;

    console.log("");
    console.log(chalk.dim("  ─── Commit preview ───"));
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
      message: "Ready to commit?",
      options: [
        { value: "commit", label: "Commit with this message", hint: "" },
        {
          value: "edit",
          label: "Edit before committing",
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
      p.cancel("Commit cancelled. Your staged files are still staged.");
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
    await commitWithMessage(finalMessage);
    p.log.success(chalk.green(`Committed: "${finalSubject}"`));
    break;
  }

  p.outro(chalk.bold.cyan("🚀 All done! Run git push whenever you're ready."));
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
  $ pushprep config --key API_KEY    Save your Gemini API key
  $ pushprep config --show           Show saved API key (masked)
  $ pushprep config --remove         Delete the saved API key

Get a free Gemini API key at: https://aistudio.google.com/app/apikey
`,
  );

// Shared flags for the workflow commands (default + `run`).
function addWorkflowOptions(cmd) {
  return cmd.option(
    "-m, --model <name>",
    "Override the AI model (also settable via PUSHPREP_MODEL)",
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
