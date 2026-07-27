import path from "path";

// ─── Shared, provider-agnostic logic ─────────────────────────────────────────
// Every AI provider (Gemini, Claude, OpenAI, Ollama) gets the SAME prompt and
// must return the SAME { subject, body }[] shape, so all of this lives here and
// is reused by each provider module. Only the actual API call differs per
// provider.

export const DEFAULT_TEMPERATURE = 0.4;
// Diff budget, in characters (~4 chars per token). Big enough that a typical
// multi-file commit survives intact, small enough that a single run costs a few
// thousand tokens rather than tens of thousands — free-tier keys last far longer.
// The file list and --stat summary always go in whole, so a truncated diff still
// yields a message that covers every file.
export const DIFF_CHAR_LIMIT = 12000;
// Cap on generated tokens. Three subject+body suggestions comfortably fit; the
// cap stops a runaway response from burning quota.
export const MAX_OUTPUT_TOKENS = 1200;
export const API_TIMEOUT_MS = 30000;
export const MIN_BODY_LENGTH = 120;
export const DEBUG = process.env.PUSHPREP_DEBUG === "1";

/**
 * Races a promise against a timeout so a slow provider can't hang the CLI.
 */
export function withTimeout(promise, ms = API_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

/**
 * Resolves the ordered list of models to attempt for a provider: the caller's
 * explicit choice first, then the provider's fallback chain. Deduped.
 */
export function resolveChain(preferred, defaultModel, fallbackModels) {
  const chosen = preferred || defaultModel;
  return [...new Set([chosen, ...fallbackModels])];
}

/**
 * Classifies an error into a coarse kind used for user-facing messaging.
 * @returns {"quota"|"invalidKey"|"modelNotFound"|"badRequest"|"timeout"|"safety"|"parse"|"network"}
 */
export function classifyError(status, message) {
  const msg = (message || "").toLowerCase();
  if (isQuotaError(status, message)) return "quota";
  if (isInvalidKeyError(status, message)) return "invalidKey";
  if (isModelNotFoundError(status, message)) return "modelNotFound";
  if (message === "invalid_format") return "parse";
  if (message === "timeout") return "timeout";
  if (msg.includes("safety") || msg.includes("blocked")) return "safety";
  if (isBadRequestError(status, message)) return "badRequest";
  return "network";
}

/** Detects a quota/rate-limit error. */
export function isQuotaError(status, message) {
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

/** Detects a model-not-found / retired-model error (worth trying the next model). */
export function isModelNotFoundError(status, message) {
  const msg = message?.toLowerCase() || "";
  return (
    status === 404 ||
    msg.includes("model not found") ||
    (msg.includes("models/") && msg.includes("not found")) ||
    msg.includes("is not found") ||
    msg.includes("does not exist") ||
    // Google retires models with this exact wording, and returns 404 for it.
    msg.includes("no longer available")
  );
}

/**
 * Detects an invalid / unauthorized API key error.
 *
 * Deliberately does NOT treat a bare 400 as a bad key. Gemini returns 400
 * INVALID_ARGUMENT for any malformed request — an unsupported generationConfig
 * field, a bad schema — and blaming the key there sent users off rotating a
 * perfectly good key while the real fault was in our own request body.
 * A genuinely rejected key is 401/403, or a 400 whose body says so explicitly.
 */
export function isInvalidKeyError(status, message) {
  const msg = message?.toLowerCase() || "";
  return (
    status === 401 ||
    status === 403 ||
    msg.includes("api key not valid") ||
    msg.includes("api_key_invalid") ||
    msg.includes("invalid api key") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("incorrect api key") ||
    msg.includes("api key expired") ||
    msg.includes("permission denied") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication")
  );
}

/**
 * Detects a malformed-request error — our request body, not the user's key.
 * Worth retrying the same prompt against the next model, since the usual cause
 * is a generationConfig field the current model doesn't accept.
 */
export function isBadRequestError(status, message) {
  const msg = message?.toLowerCase() || "";
  return (
    status === 400 ||
    msg.includes("invalid_argument") ||
    msg.includes("invalid argument")
  );
}

/**
 * Builds the commit-message prompt. Asks for a detailed Conventional Commit that
 * covers the ENTIRE staged changeset (subject line + multi-line body).
 */
export function buildPrompt(diff, stagedFiles, diffStat = "") {
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
 * Parses and validates a raw model response into exactly 3 {subject, body}
 * objects. Throws Error("invalid_format") on any shape/quality problem so the
 * caller falls back gracefully. Shared by every provider.
 */
export function parseCommitMessages(text) {
  const cleaned = (text || "")
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("invalid_format");
  }

  // Some providers wrap the array in an object like { commits: [...] }.
  if (!Array.isArray(parsed) && parsed && typeof parsed === "object") {
    const arr = Object.values(parsed).find((v) => Array.isArray(v));
    if (arr) parsed = arr;
  }

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error("invalid_format");
  }

  return parsed.slice(0, 3).map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.subject !== "string" ||
      typeof entry.body !== "string"
    ) {
      throw new Error("invalid_format");
    }
    const subject = entry.subject.trim();
    // Models often emit the literal characters "\n" instead of a real newline
    // (they copy the "\n" notation from the prompt). Normalize to real newlines.
    const body = entry.body.replace(/\\r\\n|\\n/g, "\n").trim();
    if (subject.length === 0 || body.length < MIN_BODY_LENGTH) {
      throw new Error("invalid_format");
    }
    return { subject, body };
  });
}

/**
 * Generates 3 local fallback commit messages from staged file names, used when
 * the AI is unavailable. Each is a { subject, body } object.
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
    { subject: `fix(${scope}): apply changes and fixes`, body: sharedBody },
  ];
}
