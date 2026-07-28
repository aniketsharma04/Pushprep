import chalk from "chalk";
import {
  parseCommitMessages,
  resolveChain,
  isModelNotFoundError,
  MAX_OUTPUT_TOKENS,
  DEBUG,
} from "../prompt.js";

// Ollama runs entirely on the user's machine — no API key, no SDK, just HTTP.
// Local models load into memory on first call, which can take a while, so this
// gets a much more generous timeout than the cloud providers.
//
// 90s was not enough: a cold start on a CPU-only box with a realistic
// multi-file diff measured ~120s (5s model load + 66s prompt eval + 49s
// generation), so every such run timed out and fell back to generic messages.
// There's no per-token cost locally, so waiting is cheap compared to a useless
// result — but a slow machine can still need more, hence the env override.
function ollamaTimeoutMs() {
  const raw = Number(process.env.PUSHPREP_OLLAMA_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 240000;
}

// Ollama's `format: "json"` only guarantees *syntactically* valid JSON, and in
// practice small local models answer a "return 3 objects" prompt with a single
// object — which parseCommitMessages rejects, so every run silently degraded to
// the generic fallback messages. Passing a real JSON schema (Ollama structured
// outputs) constrains decoding to the exact shape we need instead.
const COMMIT_SCHEMA = {
  type: "array",
  minItems: 3,
  maxItems: 3,
  items: {
    type: "object",
    properties: {
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["subject", "body"],
  },
};

function ollamaHost() {
  const host = process.env.OLLAMA_HOST || "http://localhost:11434";
  // Allow a bare "host:port" too (Ollama's own env var convention).
  return /^https?:\/\//.test(host) ? host : `http://${host}`;
}

/**
 * POSTs to Ollama's /api/chat with a wall-clock timeout via AbortController.
 * Turns connection refusals and non-2xx responses into errors the shared
 * classifier understands.
 */
async function ollamaChat(modelName, prompt, temperature) {
  const host = ollamaHost();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ollamaTimeoutMs());

  let res;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        // A schema, not "json" — see COMMIT_SCHEMA above.
        format: COMMIT_SCHEMA,
        options: {
          // Honour the caller's temperature so "🔄 Regenerate" actually varies.
          ...(typeof temperature === "number" ? { temperature } : {}),
          num_predict: MAX_OUTPUT_TOKENS,
        },
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("timeout");
    // ECONNREFUSED etc. — Ollama isn't running or the host is wrong.
    throw new Error(
      `Cannot reach Ollama at ${host}. Is it running? Start it with "ollama serve" or install from https://ollama.com`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      // non-JSON error body; keep the status line
    }
    const error = new Error(detail);
    error.status = res.status;
    throw error;
  }

  const data = await res.json();
  const text = (data?.message?.content || "").trim();
  if (DEBUG) {
    console.log(chalk.magenta("[pushprep:debug] ollama raw response:"));
    console.log(chalk.dim(text));
  }
  return text;
}

export const ollama = {
  id: "ollama",
  label: "Ollama (local)",
  // No key — everything runs locally.
  needsKey: false,
  envKeys: [],
  keyUrl: null,
  // A widely-used small local model. Users pick their own installed model via
  // config or --model; if it isn't pulled, the error tells them how.
  defaultModel: "llama3.2",
  fallbackModels: ["llama3.2"],

  /**
   * Runs the chosen local model. Returns { messages, model } or throws. There's
   * no cloud fallback chain worth walking — a model the user hasn't pulled
   * should surface a clear "pull it" message, not silently try another.
   */
  async generate({ prompt, model, temperature }) {
    const chain = resolveChain(model, this.defaultModel, this.fallbackModels);
    let lastError;
    for (let i = 0; i < chain.length; i++) {
      try {
        const raw = await ollamaChat(chain[i], prompt, temperature);
        return { messages: parseCommitMessages(raw), model: chain[i] };
      } catch (err) {
        lastError = err;
        const message = err?.message || String(err);
        if (isModelNotFoundError(err?.status, message)) {
          // Turn Ollama's terse 404 into an actionable instruction.
          throw new Error(
            `Model "${chain[i]}" isn't installed. Pull it first: ollama pull ${chain[i]}`,
          );
        }
        throw err;
      }
    }
    throw lastError;
  },

  /**
   * Lightweight liveness probe for `pushprep doctor`: confirms the server is up
   * and the chosen model is present.
   */
  async check({ model }) {
    const host = ollamaHost();
    const wanted = model || this.defaultModel;
    try {
      const res = await fetch(`${host}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return {
          ok: false,
          model: wanted,
          kind: "network",
          message: `Ollama responded with HTTP ${res.status}`,
        };
      }
      const data = await res.json();
      // Ollama tags carry a :tag suffix (e.g. "llama3.2:latest"); match loosely.
      const entry = (data?.models || []).find(
        (m) => m.name === wanted || m.name?.split(":")[0] === wanted,
      );
      if (!entry) {
        return {
          ok: false,
          model: wanted,
          kind: "modelNotFound",
          message: `Model "${wanted}" isn't installed. Pull it: ollama pull ${wanted}`,
        };
      }
      // An installed model isn't necessarily a *chat* model — pointing pushprep
      // at an embedding model (nomic-embed-text and friends) used to pass this
      // check and then fail at commit time with a 400. Older Ollama builds omit
      // `capabilities`, so only fail when it's present and says otherwise.
      const caps = entry.capabilities;
      if (Array.isArray(caps) && caps.length && !caps.includes("completion")) {
        return {
          ok: false,
          model: wanted,
          kind: "badRequest",
          message: `Model "${wanted}" only supports ${caps.join("/")} — it can't generate chat responses. Pick a chat model, e.g. ollama pull ${this.defaultModel}`,
        };
      }
      return { ok: true, model: wanted };
    } catch (err) {
      const message =
        err?.name === "TimeoutError"
          ? `Cannot reach Ollama at ${host} (timed out). Is it running?`
          : `Cannot reach Ollama at ${host}. Start it with "ollama serve" or install from https://ollama.com`;
      return { ok: false, model: wanted, kind: "network", message };
    }
  },
};
