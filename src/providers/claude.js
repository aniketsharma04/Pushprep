import chalk from "chalk";
import {
  parseCommitMessages,
  resolveChain,
  withTimeout,
  isModelNotFoundError,
  classifyError,
  DEBUG,
} from "../prompt.js";

// A single forced tool is the most reliable way to get structured output out of
// Claude: tool_choice pins it to this tool, so the model MUST return input that
// validates against the schema below — no drifting to prose or a string array.
// The { commits: [...] } wrapper is unwrapped for free by parseCommitMessages.
const COMMIT_TOOL = {
  name: "emit_commit_messages",
  description:
    "Return exactly 3 alternative Conventional Commit messages describing the staged changes.",
  input_schema: {
    type: "object",
    properties: {
      commits: {
        type: "array",
        description: "Exactly 3 commit message options.",
        items: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description:
                "Conventional Commit subject line: 'type(scope): description', imperative mood, under 72 chars.",
            },
            body: {
              type: "string",
              description:
                "3-6 line explanation covering the whole changeset with real identifier names. Newline-separated; at least 120 chars total.",
            },
          },
          required: ["subject", "body"],
        },
      },
    },
    required: ["commits"],
  },
};

// The Anthropic SDK is imported lazily (and cached) so Gemini/Ollama users never
// pay its load cost.
let AnthropicCtor;
async function loadAnthropic() {
  if (!AnthropicCtor) {
    ({ default: AnthropicCtor } = await import("@anthropic-ai/sdk"));
  }
  return AnthropicCtor;
}

/**
 * One Claude generation call for a single model. Returns raw JSON text (the tool
 * input serialized) so the shared parser can validate it exactly like Gemini's.
 */
async function callClaude(modelName, apiKey, prompt) {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({ apiKey });

  const response = await withTimeout(
    client.messages.create({
      model: modelName,
      max_tokens: 2048,
      tools: [COMMIT_TOOL],
      tool_choice: { type: "tool", name: COMMIT_TOOL.name },
      messages: [{ role: "user", content: prompt }],
    }),
  );

  const toolUse = response.content.find((b) => b.type === "tool_use");
  // No tool_use block means the model refused or returned prose — treat as a
  // parse failure so the caller falls back gracefully.
  if (!toolUse) throw new Error("invalid_format");

  const text = JSON.stringify(toolUse.input);
  if (DEBUG) {
    console.log(chalk.magenta("[pushprep:debug] claude tool response:"));
    console.log(chalk.dim(text));
  }
  return text;
}

export const claude = {
  id: "claude",
  label: "Anthropic Claude",
  needsKey: true,
  envKeys: ["ANTHROPIC_API_KEY", "PUSHPREP_API_KEY"],
  keyUrl: "https://console.anthropic.com/settings/keys",
  // Fast & cheap default — Claude Haiku. Commit messages don't need a bigger model.
  defaultModel: "claude-haiku-4-5",
  fallbackModels: ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-sonnet-5"],

  /**
   * Tries each model in the chain, advancing only on a retired/unavailable
   * model. Returns { messages, model } or throws the last error.
   */
  async generate({ apiKey, prompt, model }) {
    const chain = resolveChain(model, this.defaultModel, this.fallbackModels);
    let lastError;
    for (let i = 0; i < chain.length; i++) {
      try {
        const raw = await callClaude(chain[i], apiKey, prompt);
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
        const Anthropic = await loadAnthropic();
        const client = new Anthropic({ apiKey });
        const response = await withTimeout(
          client.messages.create({
            model: chain[i],
            max_tokens: 16,
            messages: [
              { role: "user", content: "Reply with the single word: ok" },
            ],
          }),
        );
        // Touch the content so a malformed response surfaces here.
        response.content.find((b) => b.type === "text");
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
