import chalk from "chalk";
import {
  parseCommitMessages,
  resolveChain,
  isModelNotFoundError,
  classifyError,
  DEBUG,
} from "../prompt.js";

// Ollama runs entirely on the user's machine — no API key, no SDK, just HTTP.
// Local models load into memory on first call, which can take a while, so this
// gets a much more generous timeout than the cloud providers.
const OLLAMA_TIMEOUT_MS = 90000;

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
async function ollamaChat(modelName, prompt) {
  const host = ollamaHost();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

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
        // "json" mode forces syntactically valid JSON; the prompt supplies the shape.
        format: "json",
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
  async generate({ prompt, model }) {
    const chain = resolveChain(model, this.defaultModel, this.fallbackModels);
    let lastError;
    for (let i = 0; i < chain.length; i++) {
      try {
        const raw = await ollamaChat(chain[i], prompt);
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
      const installed = (data?.models || []).map((m) => m.name);
      // Ollama tags carry a :tag suffix (e.g. "llama3.2:latest"); match loosely.
      const present = installed.some(
        (name) => name === wanted || name.split(":")[0] === wanted,
      );
      if (!present) {
        return {
          ok: false,
          model: wanted,
          kind: "modelNotFound",
          message: `Model "${wanted}" isn't installed. Pull it: ollama pull ${wanted}`,
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
