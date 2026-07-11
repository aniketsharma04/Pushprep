import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "src", "cli.js");

// These spawn the real CLI, so they catch import errors, syntax breakage, and
// broken Commander wiring across every module — the class of regression a unit
// test on a single function can miss.

test("CLI prints its version", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "--version"]);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("CLI prints help with the documented commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, [CLI, "--help"]);
  assert.match(stdout, /Format → Stage → AI Commit/);
  assert.match(stdout, /doctor/);
  assert.match(stdout, /--push/);
  assert.match(stdout, /--amend/);
});
