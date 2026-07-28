import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ollama } from "../src/providers/ollama.js";

// The Ollama provider talks plain HTTP, so a stubbed global fetch exercises the
// whole thing — request shape, error mapping, capability checks — with no local
// server required. These run in CI where no Ollama is installed.

const realFetch = globalThis.fetch;
const realHost = process.env.OLLAMA_HOST;
let calls = [];

/** Stubs fetch with a canned reply, recording every request for assertions. */
function stubFetch(reply) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || "{}") });
    if (typeof reply === "function") return reply();
    return reply;
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** A well-formed model reply: 3 objects with bodies past MIN_BODY_LENGTH. */
function chatReply(count = 3) {
  const body =
    "Adds resolveChain() in prompt.js so each provider walks the same model list, " +
    "and wires COMMIT_SCHEMA through ollamaChat() to constrain decoding. " +
    "Keeps the fallback path intact when the server is unreachable.";
  return jsonResponse(200, {
    message: {
      content: JSON.stringify(
        Array.from({ length: count }, (_, i) => ({
          subject: `feat(prompt): constrain ollama output ${i}`,
          body,
        })),
      ),
    },
  });
}

beforeEach(() => {
  delete process.env.OLLAMA_HOST;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realHost === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = realHost;
});

// ─── Request shape ───────────────────────────────────────────────────────────
test("generate posts a JSON schema, not bare json mode", async () => {
  // Regression: format:"json" only guaranteed valid JSON, so local models
  // returned a single object instead of 3 and every run hit the fallback.
  stubFetch(chatReply());
  await ollama.generate({ prompt: "p", model: "llama3.2" });

  const { body } = calls[0];
  assert.equal(typeof body.format, "object");
  assert.equal(body.format.type, "array");
  assert.equal(body.format.minItems, 3);
  assert.equal(body.format.items.required.includes("subject"), true);
  assert.equal(body.format.items.required.includes("body"), true);
});

test("generate forwards temperature so regenerate actually varies", async () => {
  stubFetch(chatReply());
  await ollama.generate({ prompt: "p", model: "llama3.2", temperature: 0.7 });
  assert.equal(calls[0].body.options.temperature, 0.7);
});

test("generate omits temperature when the caller passes none", async () => {
  stubFetch(chatReply());
  await ollama.generate({ prompt: "p", model: "llama3.2" });
  assert.equal("temperature" in calls[0].body.options, false);
  assert.ok(calls[0].body.options.num_predict > 0);
});

test("generate returns parsed messages and the model actually used", async () => {
  stubFetch(chatReply());
  const res = await ollama.generate({ prompt: "p", model: "llama3.2" });
  assert.equal(res.model, "llama3.2");
  assert.equal(res.messages.length, 3);
  assert.match(res.messages[0].subject, /^feat\(prompt\)/);
});

test("generate falls back to the default model when none is given", async () => {
  stubFetch(chatReply());
  const res = await ollama.generate({ prompt: "p" });
  assert.equal(res.model, ollama.defaultModel);
  assert.equal(calls[0].body.model, ollama.defaultModel);
});

// ─── Host resolution ─────────────────────────────────────────────────────────
test("OLLAMA_HOST accepts a bare host:port", async () => {
  process.env.OLLAMA_HOST = "127.0.0.1:1234";
  stubFetch(chatReply());
  await ollama.generate({ prompt: "p" });
  assert.equal(calls[0].url, "http://127.0.0.1:1234/api/chat");
});

test("OLLAMA_HOST keeps an explicit scheme", async () => {
  process.env.OLLAMA_HOST = "https://box.local:9999";
  stubFetch(chatReply());
  await ollama.generate({ prompt: "p" });
  assert.equal(calls[0].url, "https://box.local:9999/api/chat");
});

// ─── Error mapping ───────────────────────────────────────────────────────────
test("a missing model becomes an actionable 'ollama pull' instruction", async () => {
  stubFetch(jsonResponse(404, { error: "model 'ghost' not found" }));
  await assert.rejects(
    () => ollama.generate({ prompt: "p", model: "ghost" }),
    /ollama pull ghost/,
  );
});

test("an unreachable server explains how to start Ollama", async () => {
  stubFetch(() => {
    throw Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
  });
  await assert.rejects(
    () => ollama.generate({ prompt: "p" }),
    /Cannot reach Ollama/,
  );
});

test("a non-chat model surfaces Ollama's own reason, not a generic error", async () => {
  stubFetch(
    jsonResponse(400, { error: '"nomic-embed-text" does not support chat' }),
  );
  await assert.rejects(
    () => ollama.generate({ prompt: "p", model: "nomic-embed-text" }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /does not support chat/);
      return true;
    },
  );
});

test("a malformed model reply is reported as invalid_format", async () => {
  // A single object rather than an array of 3 — what json-mode used to produce.
  stubFetch(
    jsonResponse(200, {
      message: { content: JSON.stringify({ subject: "x", body: "y" }) },
    }),
  );
  await assert.rejects(
    () => ollama.generate({ prompt: "p" }),
    /invalid_format/,
  );
});

// ─── doctor / check() ────────────────────────────────────────────────────────
test("check passes for an installed chat model, matching a :latest tag", async () => {
  stubFetch(
    jsonResponse(200, {
      models: [
        { name: "llama3.2:latest", capabilities: ["completion", "tools"] },
      ],
    }),
  );
  const res = await ollama.check({ model: "llama3.2" });
  assert.equal(res.ok, true);
  assert.equal(res.model, "llama3.2");
});

test("check fails with a pull hint when the model is absent", async () => {
  stubFetch(jsonResponse(200, { models: [{ name: "other:latest" }] }));
  const res = await ollama.check({ model: "llama3.2" });
  assert.equal(res.ok, false);
  assert.equal(res.kind, "modelNotFound");
  assert.match(res.message, /ollama pull llama3\.2/);
});

test("check rejects an embedding-only model instead of reporting it reachable", async () => {
  // Regression: doctor used to green-light nomic-embed-text, which then failed
  // at commit time with a 400 "does not support chat".
  stubFetch(
    jsonResponse(200, {
      models: [{ name: "nomic-embed-text:latest", capabilities: ["embedding"] }],
    }),
  );
  const res = await ollama.check({ model: "nomic-embed-text" });
  assert.equal(res.ok, false);
  assert.match(res.message, /can't generate chat responses/);
});

test("check tolerates older Ollama builds that omit capabilities", async () => {
  stubFetch(jsonResponse(200, { models: [{ name: "llama3.2:latest" }] }));
  const res = await ollama.check({ model: "llama3.2" });
  assert.equal(res.ok, true);
});

test("check reports the server as unreachable when it is down", async () => {
  stubFetch(() => {
    throw new Error("fetch failed");
  });
  const res = await ollama.check({ model: "llama3.2" });
  assert.equal(res.ok, false);
  assert.equal(res.kind, "network");
  assert.match(res.message, /Cannot reach Ollama/);
});

// ─── Provider contract ───────────────────────────────────────────────────────
test("ollama is keyless and declares no key url", () => {
  assert.equal(ollama.needsKey, false);
  assert.deepEqual(ollama.envKeys, []);
  assert.equal(ollama.keyUrl, null);
});
