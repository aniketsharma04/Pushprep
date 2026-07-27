import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import chalk from "chalk";
import {
  parseCommitMessages,
  resolveChain,
  withTimeout,
  classifyError,
  MAX_OUTPUT_TOKENS,
  DEBUG,
} from "../prompt.js";

// Error kinds that mean "this model won't work, try the next one" rather than
// "the user's setup is broken". A retired model (404), a model that rejects part
// of our request (400), and a model whose free-tier quota is spent (429) are all
// recoverable by moving down the chain — only the last model's failure is real.
const RECOVERABLE = new Set(["modelNotFound", "badRequest", "quota"]);

function errorKind(err) {
  const status = err?.status || err?.response?.status || null;
  const message = err?.message || String(err);
  return classifyError(status, message);
}

/**
 * Whether to ask a model to skip "thinking". Flash-Lite models don't think at
 * all, so sending thinkingConfig to them is pure risk: the current Flash and
 * Flash-Lite endpoints reject `thinkingBudget: 0` with 400 INVALID_ARGUMENT.
 * Only thinking-capable models get the field, and callGemini retries without it
 * if the model rejects it anyway.
 */
function supportsThinkingBudget(modelName) {
  return !/lite/i.test(modelName);
}

// JSON schema passed to Gemini via responseSchema — a hard contract the SDK
// enforces, so the model can't drift to a string array.
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
          "3-6 line explanation covering the whole changeset with real identifier names. Newline-separated; at least 120 chars total.",
      },
    },
    required: ["subject", "body"],
  },
};

/**
 * One Gemini generation call for a single model. Returns raw JSON text.
 *
 * If the model rejects the request outright (400), retries once with the
 * thinking hint stripped — that field is the only optional part of the body, and
 * models come and go on whether they accept it.
 */
async function callGemini(modelName, apiKey, prompt, temperature) {
  const genAI = new GoogleGenerativeAI(apiKey);

  const run = async (withThinking) => {
    const generationConfig = {
      responseMimeType: "application/json",
      responseSchema: COMMIT_RESPONSE_SCHEMA,
      temperature,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };
    if (withThinking) {
      // Commit generation doesn't need reasoning tokens; skipping them roughly
      // halves both latency and token spend on thinking-capable models.
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig,
    });
    const result = await withTimeout(model.generateContent(prompt));
    return result.response.text().trim();
  };

  const wantsThinking = supportsThinkingBudget(modelName);
  let text;
  try {
    text = await run(wantsThinking);
  } catch (err) {
    if (!wantsThinking || errorKind(err) !== "badRequest") throw err;
    if (DEBUG) {
      console.log(
        chalk.magenta(
          `[pushprep:debug] ${modelName} rejected thinkingConfig, retrying without it.`,
        ),
      );
    }
    text = await run(false);
  }

  if (DEBUG) {
    console.log(chalk.magenta("[pushprep:debug] gemini raw response:"));
    console.log(chalk.dim(text));
  }
  return text;
}

export const gemini = {
  id: "gemini",
  label: "Google Gemini",
  // Surfaced as "(Recommended)" in the setup wizard — its free API key is the
  // quickest to obtain (no billing setup required).
  recommended: true,
  needsKey: true,
  envKeys: ["GEMINI_API_KEY", "PUSHPREP_API_KEY"],
  keyUrl: "https://aistudio.google.com/app/apikey",
  // Floating aliases first — Google keeps them pointed at a current model, so a
  // retirement can't break the tool. Lite leads deliberately: it does no
  // "thinking", which makes it the cheapest per commit and stretches a free-tier
  // key the furthest, and commit messages don't need a reasoning model.
  // Free-tier quota is tracked per model, so a 429 on one still leaves the rest.
  defaultModel: "gemini-flash-lite-latest",
  fallbackModels: [
    "gemini-flash-lite-latest",
    "gemini-2.0-flash-lite",
    "gemini-flash-latest",
    "gemini-2.0-flash",
  ],

  /**
   * Tries each model in the chain, advancing whenever the failure is the model's
   * fault (retired, out of quota, or rejecting our request) rather than the
   * user's. Returns { messages, model } or throws the last error.
   */
  async generate({ apiKey, prompt, temperature, model }) {
    const chain = resolveChain(model, this.defaultModel, this.fallbackModels);
    let lastError;
    for (let i = 0; i < chain.length; i++) {
      try {
        const raw = await callGemini(chain[i], apiKey, prompt, temperature);
        return { messages: parseCommitMessages(raw), model: chain[i] };
      } catch (err) {
        lastError = err;
        if (RECOVERABLE.has(errorKind(err)) && i < chain.length - 1) {
          if (DEBUG) {
            console.log(
              chalk.magenta(
                `[pushprep:debug] ${chain[i]} failed (${errorKind(err)}), trying next.`,
              ),
            );
          }
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  },

  /**
   * Lightweight liveness probe for `pushprep doctor`.
   */
  async check({ apiKey, model }) {
    const chain = resolveChain(model, this.defaultModel, this.fallbackModels);
    let lastError;
    for (let i = 0; i < chain.length; i++) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const m = genAI.getGenerativeModel({
          model: chain[i],
          generationConfig: { maxOutputTokens: 16 },
        });
        const result = await withTimeout(
          m.generateContent("Reply with the single word: ok"),
        );
        result.response.text();
        return { ok: true, model: chain[i] };
      } catch (err) {
        lastError = err;
        const message = err?.message || String(err);
        const kind = errorKind(err);
        // Keep probing: the point of doctor is to answer "can this key reach
        // ANY model?", so a single dead or exhausted model isn't a verdict.
        if (RECOVERABLE.has(kind) && i < chain.length - 1) continue;
        return { ok: false, model: chain[i], kind, message };
      }
    }
    const status = lastError?.status || null;
    const message = lastError?.message || String(lastError);
    return {
      ok: false,
      model: chain[chain.length - 1],
      kind: classifyError(status, message),
      message,
    };
  },
};
