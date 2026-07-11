import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import chalk from "chalk";
import path from "path";

// Model is overridable via env var for experimentation.
// Default is the floating "flash-latest" alias: Google keeps it pointed at a
// current, widely-available Flash model that follows structured-output
// (responseSchema) contracts. Using the alias (instead of a pinned version like
// gemini-2.5-flash) means the tool doesn't break when Google retires a specific
// model version for new API keys.
const MODEL_NAME = process.env.PUSHPREP_MODEL || "gemini-flash-latest";
// Gemini Flash has a very large context window, so we can afford a generous
// diff budget. A tiny limit was causing multi-file commits to lose files
// (and get described only partially). Paired with the --stat summary below,
// this keeps the full scope of the change in view.
const DIFF_CHAR_LIMIT = 20000;
const API_TIMEOUT_MS = 30000;
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
 * Asks for a detailed Conventional Commit that covers the ENTIRE staged
 * changeset (subject line + multi-line explanatory body).
 */
function buildPrompt(diff, stagedFiles, diffStat = "") {
  const truncatedDiff = diff.slice(0, DIFF_CHAR_LIMIT);
  const wasTruncated = diff.length > DIFF_CHAR_LIMIT;
  const fileList = stagedFiles.join(", ");

  const statBlock = diffStat
    ? `\nChange summary (git diff --stat — this lists EVERY changed file, use it so you never miss one):\n${diffStat}\n`
    : "";

  return `You are a senior software engineer writing one high-quality git commit message that describes ALL of the staged changes below.

Return a JSON array of exactly 3 objects, each matching the schema {subject, body}. Do NOT return plain strings. Do NOT omit the body. Do NOT wrap the output in markdown or backticks.

Staged files (${stagedFiles.length}): ${fileList}
${statBlock}
Git diff (staged changes${wasTruncated ? " — TRUNCATED for length; rely on the file list and change summary above for the complete scope" : ""}):
\`\`\`
${truncatedDiff}
\`\`\`

COVER THE WHOLE CHANGE — this is the most important rule:
- The change may span MULTIPLE files and several distinct concerns. Describe the COMPLETE changeset, never just one file or the last hunk.
- The subject names the primary theme of the whole change.
- The body then accounts for EVERY meaningful change across all the files above — roughly one concise sentence per distinct change. Do not silently drop any file from the summary.

SUBJECT rules:
- Format: "type(scope): description"
- Imperative mood ("add", "fix", "remove" — not "added", "fixes").
- Under 72 characters.
- Valid types: feat, fix, refactor, chore, docs, style, test, perf, ci. Choose the type that matches what actually changed.

BODY rules:
- 3 to 6 lines, separated by a single newline (\\n). No bullet markers, no dashes, no leading symbols.
- Every line must name something CONCRETE from the diff: a real function, file, module, constant, or config key. Never vague filler like "improves code quality", "updates files", or "various changes".
- Cover WHAT changed across all the files, and WHY (the motivation, the bug fixed, the feature enabled). Include a line for any notable impact, trade-off, or follow-up a reviewer should know.
- Be specific and accurate. NEVER invent a change that is not present in the diff or the file summary.

THREE-OPTIONS rule:
- All three options must accurately describe the SAME real change and use the correct type. They are alternate phrasings of one commit, NOT three different stories.
- Vary them by wording, emphasis, and level of detail (e.g. one tight and punchy, one more thorough). Do NOT force one to be a "fix" and another a "refactor" when the change is actually a feature. Accuracy always wins over variety.

POSITIVE EXAMPLE (a multi-file change — note how the body accounts for each part):
[
  {"subject":"feat(cart): add coupon support with server-side validation","body":"Adds applyCoupon() in cartService.js to look up a code and recompute totals, plus a COUPON_CODES constant for the initial set.\\nWires a new /api/coupons/validate route in routes/coupons.js so codes are verified on the server, not just the client.\\nUpdates CartSummary.jsx to render the discount line and surface invalid-code errors inline.\\nPrevents price tampering by never trusting a client-computed discount."},
  {"subject":"feat(cart): support discount coupons end to end","body":"Introduces coupon handling across the cart: applyCoupon() and COUPON_CODES in cartService.js compute the discounted total.\\nA /api/coupons/validate endpoint in routes/coupons.js validates each code against the server list.\\nCartSummary.jsx now shows the applied discount and any validation error.\\nCloses the gap where discounts could be faked from the browser."},
  {"subject":"feat(cart): add coupon codes and discount rendering","body":"Implements coupon application in cartService.js (applyCoupon, COUPON_CODES) and exposes server validation via routes/coupons.js.\\nCartSummary.jsx is updated to display the discount and inline errors for bad codes.\\nKeeps total calculation authoritative on the server for security."}
]

Reminder: return ONLY the JSON array of 3 {subject, body} objects. Each body must cover the full changeset and name real identifiers.`;
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
 * @param {string} [diffStat] - per-file summary (git diff --staged --stat)
 * @returns {Promise<{ messages: { subject: string, body: string }[], usedFallback: boolean }>}
 */
export async function generateCommitMessages(
  diff,
  stagedFiles,
  apiKey,
  diffStat = "",
) {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: COMMIT_RESPONSE_SCHEMA,
        temperature: 0.4,
        // Disable "thinking" for this task: commit-message generation doesn't
        // need it, and leaving it on roughly doubles latency (25s+ vs ~12s),
        // which pushes runs past the timeout into the generic fallback.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const prompt = buildPrompt(diff, stagedFiles, diffStat);

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
      // Models often emit the literal characters "\n" (backslash + n) inside the
      // body instead of a real newline, because the prompt describes line breaks
      // as "\n". Normalize those to actual newlines so the preview renders on
      // separate lines and the commit stores a proper multi-line body.
      const body = entry.body.replace(/\\r\\n|\\n/g, "\n").trim();
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
