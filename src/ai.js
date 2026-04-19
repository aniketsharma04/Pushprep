import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import chalk from "chalk";
import path from "path";

// Model is overridable via env var for experimentation.
// Default is a stable, widely-available Flash model that reliably follows
// structured-output (responseSchema) contracts.
const MODEL_NAME = process.env.PUSHPREP_MODEL || "gemini-2.5-flash";
const DIFF_CHAR_LIMIT = 6000;
const API_TIMEOUT_MS = 25000;
const MIN_BODY_LENGTH = 120;
const DEBUG = process.env.PUSHPREP_DEBUG === "1";

/**
 * JSON schema passed to Gemini via generationConfig.responseSchema.
 * This is a contract (not a suggestion): the SDK rejects responses
 * that don't match this shape, so the string-array drift we were
 * seeing becomes impossible.
 */
const COMMIT_RESPONSE_SCHEMA = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      subject: {
        type: SchemaType.STRING,
        description:
          "Conventional Commit subject line: 'type(scope): description', imperative mood, under 72 chars.",
      },
      body: {
        type: SchemaType.STRING,
        description:
          "2-4 line explanation. WHAT changed (with real identifier names), WHY it changed, notable impact. Plain text; newline-separated; at least 120 chars total.",
      },
    },
    required: ["subject", "body"],
  },
};

/**
 * Builds the Gemini prompt per PRD §4.5.2.
 * Asks for a detailed Conventional Commit: subject line + explanatory body.
 */
function buildPrompt(diff, stagedFiles) {
  const truncatedDiff = diff.slice(0, DIFF_CHAR_LIMIT);
  const fileList = stagedFiles.join(", ");

  return `You are a senior software engineer writing high-quality git commit messages.

Return a JSON array of exactly 3 objects, each matching the schema {subject, body}. Do NOT return plain strings. Do NOT omit the body. Do NOT wrap the output in markdown or backticks.

Staged files: ${fileList}

Git diff (staged changes):
\`\`\`
${truncatedDiff}
\`\`\`

SUBJECT rules:
- Format: "type(scope): description"
- Imperative mood ("add", "fix", "remove" — not "added", "fixes").
- Under 72 characters.
- Valid types: feat, fix, refactor, chore, docs, style, test, perf, ci.

BODY rules (this is the part you keep getting wrong — read carefully):
- Minimum 120 characters total. A body shorter than that is a failure.
- 2 to 4 lines, separated by a single newline (\\n). No bullet markers, no dashes, no leading symbols.
- Line 1 — WHAT meaningfully changed. Reference REAL identifiers from the diff: function names, module names, config keys, constants. No vague filler like "improves code quality" or "updates files".
- Line 2 — WHY the change was made: the motivation, the bug being fixed, the feature being enabled, the constraint being met.
- Line 3 (optional) — notable impact, trade-off, migration note, or follow-up a reviewer should know.
- Do NOT invent changes that are not present in the diff. If the diff is small, the body can still be short but must still name a real identifier.

VARIETY rule:
- The three options must frame the change from DIFFERENT angles. For example: option 1 emphasizes the new capability added, option 2 emphasizes the problem fixed, option 3 emphasizes the internal cleanup / structure.
- Do NOT produce three near-identical subjects.

NEGATIVE EXAMPLE (what NOT to return):
[
  "docs(prd): standardize markdown table formatting",
  "feat(cli): implement core pushprep workflow logic",
  "chore(repo): update PRD and scaffold project modules"
]
This is wrong because (1) it's a string array instead of objects, and (2) every entry is subject-only with no body.

POSITIVE EXAMPLE (what TO return):
[
  {"subject":"feat(auth): add JWT refresh token rotation","body":"Introduces refreshToken() in authService to exchange an expiring access token for a new pair.\\nPrevents silent session drops for users who keep a tab open past the 15-minute access window.\\nRefresh tokens are single-use and revoked on rotation to limit replay risk."},
  {"subject":"fix(auth): prevent session expiry on active users","body":"Active users were being logged out mid-request because the client never renewed its token.\\nThe refresh flow now fires on 401 responses and retries the original request transparently.\\nFixes the support ticket cluster reported last week."},
  {"subject":"refactor(auth): extract token validation into helper","body":"Moves duplicated jwt.verify logic out of three middleware files into validateToken().\\nCentralizes error handling so future token formats only need updating in one place.\\nNo behavior change for callers."}
]

Reminder: return ONLY the JSON array of 3 {subject, body} objects. Every body must be at least 120 characters and contain at least two sentences.`;
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
 * @returns {{ subject: string, body: string }[]}
 */
export function generateFallbackMessages(stagedFiles) {
  const firstFile = stagedFiles[0] || "app";
  const scope = path.basename(firstFile, path.extname(firstFile));
  const fileCount = stagedFiles.length;
  const fileList = stagedFiles.slice(0, 5).join(", ");
  const extra = fileCount > 5 ? ` (+${fileCount - 5} more)` : "";

  const sharedBody =
    `Touches ${fileCount} file(s): ${fileList}${extra}.\n` +
    `AI suggestions were unavailable, so this is a generic fallback — consider editing before pushing.`;

  return [
    {
      subject: `chore(${scope}): update files and apply formatting`,
      body: sharedBody,
    },
    {
      subject: `refactor(${scope}): clean up code structure`,
      body: sharedBody,
    },
    {
      subject: `fix(${scope}): apply changes and fixes`,
      body: sharedBody,
    },
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
 * @returns {Promise<{ messages: { subject: string, body: string }[], usedFallback: boolean }>}
 */
export async function generateCommitMessages(diff, stagedFiles, apiKey) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: COMMIT_RESPONSE_SCHEMA,
        temperature: 0.4,
      },
    });

    const prompt = buildPrompt(diff, stagedFiles);

    if (DEBUG) {
      console.log(chalk.magenta("\n[pushprep:debug] model: ") + MODEL_NAME);
      console.log(
        chalk.magenta("[pushprep:debug] prompt length: ") + prompt.length,
      );
      console.log(
        chalk.magenta("[pushprep:debug] diff length: ") +
          `${diff.length} (truncated to ${Math.min(diff.length, DIFF_CHAR_LIMIT)})`,
      );
    }

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), API_TIMEOUT_MS),
      ),
    ]);

    const text = result.response.text().trim();

    if (DEBUG) {
      console.log(chalk.magenta("[pushprep:debug] raw Gemini response:"));
      console.log(chalk.dim(text));
      console.log("");
    }

    // Strip accidental markdown fences (defense-in-depth; responseSchema
    // should already prevent these)
    const cleaned = text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed) || parsed.length < 3) {
      throw new Error("invalid_format");
    }

    const messages = parsed.slice(0, 3).map((entry) => {
      // No more silent string-to-object shim. If the model returns plain
      // strings (drift from the schema) we fail loudly so the user sees
      // the fallback warning instead of getting empty-body commits.
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.subject !== "string" ||
        typeof entry.body !== "string"
      ) {
        throw new Error("invalid_format");
      }
      const subject = entry.subject.trim();
      const body = entry.body.trim();
      if (subject.length === 0 || body.length < MIN_BODY_LENGTH) {
        // Body is too short to be useful — treat as format failure.
        throw new Error("invalid_format");
      }
      return { subject, body };
    });

    if (DEBUG) {
      console.log(chalk.magenta("[pushprep:debug] parsed messages:"));
      for (const [i, m] of messages.entries()) {
        console.log(
          chalk.magenta(`  [${i}] `) +
            m.subject +
            chalk.dim(` (body: ${m.body.length} chars)`),
        );
      }
      console.log("");
    }

    return { messages, usedFallback: false };
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
