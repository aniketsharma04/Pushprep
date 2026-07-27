import chalk from "chalk";

import { gemini } from "./providers/gemini.js";
import { claude } from "./providers/claude.js";
import { openai } from "./providers/openai.js";
import { ollama } from "./providers/ollama.js";
import {
  buildPrompt,
  generateFallbackMessages,
  classifyError,
  DEFAULT_TEMPERATURE,
  DIFF_CHAR_LIMIT,
  DEBUG,
} from "./prompt.js";

// ─── Provider registry ───────────────────────────────────────────────────────
// ai.js is a thin dispatcher: it builds the shared prompt, routes to the active
// provider, and handles fallback + user-facing error reporting uniformly.
const PROVIDERS = {
  [gemini.id]: gemini,
  [claude.id]: claude,
  [openai.id]: openai,
  [ollama.id]: ollama,
};

export const DEFAULT_PROVIDER = "gemini";

/** Returns the provider module for an id, defaulting to Gemini. */
export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/** Returns all registered providers. */
export function listProviders() {
  return Object.values(PROVIDERS);
}

// ─── User-facing error reporting (provider-aware) ────────────────────────────
function printQuotaError(provider) {
  const line = "━".repeat(62);
  console.log("\n" + chalk.red(line));
  console.log(chalk.red(`  🚫 ${provider.label} Quota Exhausted`));
  console.log(chalk.red(line));
  console.log("");
  console.log(`  Your current ${provider.label} key has run out of requests.`);
  console.log("");
  console.log("  What you can do:");
  if (provider.keyUrl) {
    console.log("  1. Get a new API key:");
    console.log(chalk.cyan(`     → ${provider.keyUrl}`));
    console.log("");
    console.log("  2. Update pushprep with the new key:");
    console.log(chalk.cyan("     → pushprep config --key YOUR_NEW_API_KEY"));
    console.log("");
  }
  console.log("  3. Or wait for your quota to reset (usually 24h)");
  console.log(chalk.red(line) + "\n");
}

function printInvalidKeyError(provider) {
  console.log("\n" + chalk.red(`  🔑 Invalid ${provider.label} API Key`));
  if (provider.keyUrl) {
    console.log(chalk.dim(`  Verify your key at: ${provider.keyUrl}`));
  }
  console.log(chalk.dim("  Then re-run: pushprep config --key YOUR_API_KEY\n"));
}

function reportGenerationError(provider, status, message) {
  const label = provider.label;
  switch (classifyError(status, message)) {
    case "quota":
      printQuotaError(provider);
      break;
    case "invalidKey":
      printInvalidKeyError(provider);
      break;
    case "modelNotFound":
      console.log(
        chalk.yellow(
          `\n  ⚠️  No ${label} model was reachable. Update pushprep, or set one with --model.\n`,
        ),
      );
      break;
    case "badRequest":
      console.log(
        chalk.yellow(
          `\n  ⚠️  ${label} rejected the request (not your API key — your key is fine).` +
            `\n     Try updating pushprep, or pick another model with --model.\n`,
        ),
      );
      break;
    case "timeout":
      console.log(
        chalk.yellow(
          `\n  ⚠️  ${label} took too long to respond. Using local fallback messages.\n`,
        ),
      );
      break;
    case "safety":
      console.log(
        chalk.yellow(
          `\n  ⚠️  ${label} blocked the request. Using local fallback messages.\n`,
        ),
      );
      break;
    case "parse":
      console.log(
        chalk.yellow(
          "\n  ⚠️  Could not parse the AI response. Using local fallback messages.\n",
        ),
      );
      break;
    default:
      console.log(
        chalk.yellow(
          `\n  ⚠️  Network error: ${message}. Using local fallback messages.\n`,
        ),
      );
  }
}

/**
 * Generates 3 commit message suggestions via the active provider, falling back
 * to local messages if the provider fails.
 *
 * @param {string} diff - staged git diff
 * @param {string[]} stagedFiles - list of staged file paths
 * @param {string} apiKey - provider API key (may be empty for keyless providers)
 * @param {string} [diffStat] - per-file summary (git diff --staged --stat)
 * @param {{ provider?: string, model?: string, temperature?: number }} [options]
 * @returns {Promise<{ messages: {subject,body}[], usedFallback: boolean, model?: string, provider: string }>}
 */
export async function generateCommitMessages(
  diff,
  stagedFiles,
  diffStat = "",
  options = {},
) {
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const onSwitch =
    typeof options.onSwitch === "function" ? options.onSwitch : () => {};

  // Ordered list of providers to attempt. A `chain` (multi-provider fallback:
  // [{ id, apiKey, model }, ...]) is preferred; otherwise build a single-entry
  // chain from the flat options for backward compatibility.
  const chain =
    Array.isArray(options.chain) && options.chain.length
      ? options.chain
      : [
          {
            id: options.provider || DEFAULT_PROVIDER,
            apiKey: options.apiKey,
            model: options.model || process.env.PUSHPREP_MODEL || undefined,
          },
        ];

  const prompt = buildPrompt(diff, stagedFiles, diffStat);

  if (DEBUG) {
    console.log(
      chalk.magenta("\n[pushprep:debug] provider chain: ") +
        chain.map((c) => c.id).join(" → "),
    );
    console.log(
      chalk.magenta("[pushprep:debug] prompt length: ") + prompt.length,
    );
    console.log(
      chalk.magenta("[pushprep:debug] diff length: ") +
        `${diff.length} (truncated to ${Math.min(diff.length, DIFF_CHAR_LIMIT)})`,
    );
  }

  let last = null;
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const provider = getProvider(step.id);
    try {
      const { messages, model } = await provider.generate({
        apiKey: step.apiKey,
        prompt,
        temperature,
        model: step.model,
      });
      return { messages, usedFallback: false, model, provider: provider.id };
    } catch (err) {
      const status = err?.status || err?.response?.status || null;
      const message = err?.message || err?.toString() || "";
      last = { provider, status, message };

      // If another configured provider is available, switch to it instead of
      // degrading to local messages. Only the last provider's failure is
      // reported to the user in full.
      if (i < chain.length - 1) {
        const next = getProvider(chain[i + 1].id);
        onSwitch({
          from: provider,
          to: next,
          kind: classifyError(status, message),
        });
        continue;
      }

      reportGenerationError(provider, status, message);
      return {
        messages: generateFallbackMessages(stagedFiles),
        usedFallback: true,
        provider: provider.id,
      };
    }
  }

  // Defensive — the loop always returns, but keep a safe fallback.
  return {
    messages: generateFallbackMessages(stagedFiles),
    usedFallback: true,
    provider: last?.provider?.id || DEFAULT_PROVIDER,
  };
}

/**
 * Liveness probe used by `pushprep doctor`: checks the active provider's key +
 * a reachable model.
 *
 * @param {string} apiKey
 * @param {string} [preferredModel]
 * @param {string} [providerId]
 * @returns {Promise<{ ok: boolean, model: string, kind?: string, message?: string }>}
 */
export async function checkModel(apiKey, preferredModel, providerId) {
  const provider = getProvider(providerId);
  return provider.check({ apiKey, model: preferredModel });
}

// Re-export shared helpers so existing importers (and tests) keep working.
export {
  generateFallbackMessages,
  classifyError,
  isQuotaError,
  isModelNotFoundError,
  isInvalidKeyError,
  isBadRequestError,
} from "./prompt.js";
