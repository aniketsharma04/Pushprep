import { GoogleGenerativeAI } from "@google/generative-ai";
import chalk from "chalk";
import path from "path";

const MODEL_NAME = "gemini-3.1-flash-lite-preview";
const DIFF_CHAR_LIMIT = 3000;
const API_TIMEOUT_MS = 15000;

/**
 * Builds the Gemini prompt per PRD §4.5.2.
 */
function buildPrompt(diff, stagedFiles) {
  const truncatedDiff = diff.slice(0, DIFF_CHAR_LIMIT);
  const fileList = stagedFiles.join(", ");

  return `You are a senior software engineer writing git commit messages.

Staged files: ${fileList}

Git diff (staged changes):
\`\`\`
${truncatedDiff}
\`\`\`

Generate exactly 3 commit messages following the Conventional Commits format: type(scope): description

Rules:
- Valid types: feat, fix, refactor, chore, docs, style, test, perf, ci
- Each message must be under 72 characters
- Three messages must approach the change from different angles (what changed / why / impact)
- Response must be a raw JSON array of exactly 3 strings — no markdown, no backticks, no preamble

Example: ["feat(auth): add JWT token refresh logic", "fix(auth): prevent session expiry on active users", "refactor(auth): improve token validation flow"]`;
}

/**
 * Detects if an error is a quota/rate-limit error.
 * Per PRD §5.4
 */
function isQuotaError(status, message) {
  const msg = message?.toLowerCase() || "";
  return (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("resource has been exhausted") ||
    msg.includes("too many requests")
  );
}

/**
 * Detects if an error is a model-not-found error.
 * Per PRD §5.2
 */
function isModelNotFoundError(status, message) {
  const msg = message?.toLowerCase() || "";
  return (
    status === 404 ||
    msg.includes("model not found") ||
    (msg.includes("models/") && msg.includes("not found")) ||
    msg.includes("is not found")
  );
}

/**
 * Detects if an error is an invalid API key error.
 * Per PRD §5.4
 */
function isInvalidKeyError(status, message) {
  const msg = message?.toLowerCase() || "";
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    msg.includes("api key not valid") ||
    msg.includes("invalid api key") ||
    msg.includes("permission denied") ||
    msg.includes("unauthorized")
  );
}

/**
 * Prints the formatted quota exhaustion block per PRD §5.3.
 */
function printQuotaError() {
  const line = "━".repeat(62);
  console.log("\n" + chalk.red(line));
  console.log(chalk.red("  🚫 Gemini API Quota Exhausted"));
  console.log(chalk.red(line));
  console.log("");
  console.log("  Your current Gemini API key has run out of tokens/requests.");
  console.log("");
  console.log("  What you can do:");
  console.log("  1. Get a new API key from a different Google account:");
  console.log(chalk.cyan("     → https://aistudio.google.com/app/apikey"));
  console.log("");
  console.log("  2. Update pushprep with the new key:");
  console.log(chalk.cyan("     → pushprep config --key YOUR_NEW_API_KEY"));
  console.log("");
  console.log("  3. Or wait for your quota to reset (usually 24h)");
  console.log(chalk.red(line) + "\n");
}

/**
 * Prints a formatted invalid key error.
 */
function printInvalidKeyError() {
  console.log("\n" + chalk.red("  🔑 Invalid Gemini API Key"));
  console.log(
    chalk.dim("  Verify your key at: https://aistudio.google.com/app/apikey"),
  );
  console.log(chalk.dim("  Then re-run: pushprep config --key YOUR_API_KEY\n"));
}

/**
 * Generates 3 local fallback commit messages using staged file names.
 * Per PRD §4.5.4
 * @param {string[]} stagedFiles
 */
export function generateFallbackMessages(stagedFiles) {
  const firstFile = stagedFiles[0] || "app";
  const scope = path.basename(firstFile, path.extname(firstFile));
  return [
    `chore(${scope}): update files and apply formatting`,
    `refactor(${scope}): clean up code structure`,
    `fix(${scope}): apply changes and fixes`,
  ];
}

/**
 * Calls Gemini API to generate 3 commit message suggestions.
 * Falls back to local messages on any failure, except quota/key errors
 * which are shown to the user but still end with fallback.
 *
 * @param {string} diff - staged git diff
 * @param {string[]} stagedFiles - list of staged file paths
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<{ messages: string[], usedFallback: boolean }>}
 */
export async function generateCommitMessages(diff, stagedFiles, apiKey) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    const prompt = buildPrompt(diff, stagedFiles);

    // Race between the API call and a 15s timeout
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), API_TIMEOUT_MS),
      ),
    ]);

    const text = result.response.text().trim();

    // Strip accidental markdown fences
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const messages = JSON.parse(cleaned);

    if (
      !Array.isArray(messages) ||
      messages.length < 3 ||
      messages.some((m) => typeof m !== "string")
    ) {
      throw new Error("invalid_format");
    }

    return { messages: messages.slice(0, 3), usedFallback: false };
  } catch (err) {
    const status = err?.status || err?.response?.status || null;
    const message = err?.message || err?.toString() || "";

    if (isQuotaError(status, message)) {
      printQuotaError();
    } else if (isInvalidKeyError(status, message)) {
      printInvalidKeyError();
    } else if (isModelNotFoundError(status, message)) {
      console.log(
        chalk.yellow(
          "\n  ⚠️  Gemini model unavailable. Update pushprep to the latest version.\n",
        ),
      );
    } else if (message === "timeout") {
      console.log(
        chalk.yellow(
          "\n  ⚠️  Gemini took too long to respond. Using local fallback messages.\n",
        ),
      );
    } else if (
      message.toLowerCase().includes("safety") ||
      message.toLowerCase().includes("blocked")
    ) {
      console.log(
        chalk.yellow(
          "\n  ⚠️  Gemini blocked the request. Using local fallback messages.\n",
        ),
      );
    } else if (message === "invalid_format") {
      console.log(
        chalk.yellow(
          "\n  ⚠️  Could not parse AI response. Using local fallback messages.\n",
        ),
      );
    } else {
      console.log(
        chalk.yellow(
          `\n  ⚠️  Network error: ${message}. Using local fallback messages.\n`,
        ),
      );
    }

    return {
      messages: generateFallbackMessages(stagedFiles),
      usedFallback: true,
    };
  }
}
