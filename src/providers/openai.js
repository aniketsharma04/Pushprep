import chalk from "chalk";
import {
  parseCommitMessages,
  resolveChain,
  withTimeout,
  isModelNotFoundError,
  classifyError,
  DEBUG,
} from "../prompt.js";

// Strict structured-output schema. OpenAI enforces this server-side, so the
// model can't return prose or a bare string array. strict mode requires every
// object to set additionalProperties:false and list all props in `required`.
// The { commits: [...] } wrapper is unwrapped for free by parseCommitMessages.
const COMMIT_SCHEMA = {
  type: "object",
  properties: {
    commits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["subject", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["commits"],
  additionalProperties: false,
};

// Lazily imported (and cached) so non-OpenAI users never pay its load cost.
let OpenAICtor;
async function loadOpenAI() {
  if (!OpenAICtor) {
    ({ default: OpenAICtor } = await import("openai"));
  }
  return OpenAICtor;
}

/**
 * One OpenAI generation call for a single model. Returns raw JSON text so the
 * shared parser can validate it exactly like the other providers.
 */
async function callOpenAI(modelName, apiKey, prompt) {
  const OpenAI = await loadOpenAI();
  const client = new OpenAI({ apiKey });

  const response = await withTimeout(
    client.chat.completions.create({
      model: modelName,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "commit_messages",
          strict: true,
          schema: COMMIT_SCHEMA,
        },
      },
    }),
  );

  const text = response.choices?.[0]?.message?.content?.trim() || "";
  if (DEBUG) {
    console.log(chalk.magenta("[pushprep:debug] openai raw response:"));
    console.log(chalk.dim(text));
  }
  return text;
}

export const openai = {
  id: "openai",
  label: "OpenAI",
  needsKey: true,
  envKeys: ["OPENAI_API_KEY", "PUSHPREP_API_KEY"],
  keyUrl: "https://platform.openai.com/api-keys",
  // Fast & cheap default — GPT mini. Commit messages don't need a bigger model.
  defaultModel: "gpt-4o-mini",
  fallbackModels: ["gpt-4o-mini", "gpt-4.1-mini"],

  /**
   * Tries each model in the chain, advancing only on a retired/unavailable
   * model. Returns { messages, model } or throws the last error.
   */
  async generate({ apiKey, prompt, model }) {
    const chain = resolveChain(model, this.defaultModel, this.fallbackModels);
    let lastError;
    for (let i = 0; i < chain.length; i++) {
      try {
        const raw = await callOpenAI(chain[i], apiKey, prompt);
        return { messages: parseCommitMessages(raw), model: chain[i] };
      } catch (err) {
        lastError = err;
        const status = err?.status || err?.response?.status || null;
        const message = err?.message || String(err);
        if (isModelNotFoundError(status, message) && i < chain.length - 1) {
          if (DEBUG) {
            console.log(
              chalk.magenta(
                `[pushprep:debug] ${chain[i]} unavailable, trying next.`,
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
        const OpenAI = await loadOpenAI();
        const client = new OpenAI({ apiKey });
        const response = await withTimeout(
          client.chat.completions.create({
            model: chain[i],
            max_tokens: 16,
            messages: [
              { role: "user", content: "Reply with the single word: ok" },
            ],
          }),
        );
        // Touch the content so a malformed response surfaces here.
        response.choices?.[0]?.message?.content;
        return { ok: true, model: chain[i] };
      } catch (err) {
        lastError = err;
        const status = err?.status || err?.response?.status || null;
        const message = err?.message || String(err);
        if (isModelNotFoundError(status, message) && i < chain.length - 1) {
          continue;
        }
        return {
          ok: false,
          model: chain[i],
          kind: classifyError(status, message),
          message,
        };
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
