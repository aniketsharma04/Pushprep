import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateFallbackMessages,
  isQuotaError,
  isModelNotFoundError,
  isInvalidKeyError,
  classifyError,
} from "../src/ai.js";
import { getExtension } from "../src/formatter.js";
import { getApiKey } from "../src/config.js";

// ─── ai.js: fallback messages ────────────────────────────────────────────────
test("generateFallbackMessages returns 3 well-formed {subject, body} objects", () => {
  const msgs = generateFallbackMessages(["src/app.js", "src/util.js"]);
  assert.equal(msgs.length, 3);
  for (const m of msgs) {
    assert.equal(typeof m.subject, "string");
    assert.equal(typeof m.body, "string");
    assert.ok(m.subject.length > 0);
    assert.ok(m.body.includes("src/app.js"));
  }
});

test("generateFallbackMessages derives scope from the first staged file", () => {
  const [first] = generateFallbackMessages(["components/Button.jsx"]);
  assert.match(first.subject, /\(Button\)/);
});

test("generateFallbackMessages tolerates an empty file list", () => {
  const msgs = generateFallbackMessages([]);
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].subject, /\(app\)/); // default scope
});

// ─── ai.js: error classification ─────────────────────────────────────────────
test("isQuotaError detects 429 and quota phrasing", () => {
  assert.ok(isQuotaError(429, ""));
  assert.ok(isQuotaError(null, "Resource has been exhausted"));
  assert.ok(isQuotaError(null, "Too Many Requests"));
  assert.ok(!isQuotaError(200, "all good"));
});

test("isModelNotFoundError detects retired/unavailable models", () => {
  assert.ok(isModelNotFoundError(404, ""));
  assert.ok(isModelNotFoundError(null, "models/gemini-2.5-flash is not found"));
  assert.ok(!isModelNotFoundError(200, "ok"));
});

test("isInvalidKeyError detects auth failures", () => {
  assert.ok(isInvalidKeyError(401, ""));
  assert.ok(isInvalidKeyError(403, ""));
  assert.ok(isInvalidKeyError(null, "API key not valid"));
  assert.ok(!isInvalidKeyError(200, "ok"));
});

test("classifyError maps errors to the right kind", () => {
  assert.equal(classifyError(429, ""), "quota");
  assert.equal(classifyError(401, ""), "invalidKey");
  assert.equal(classifyError(404, ""), "modelNotFound");
  assert.equal(classifyError(null, "timeout"), "timeout");
  assert.equal(classifyError(null, "blocked for safety"), "safety");
  assert.equal(classifyError(null, "invalid_format"), "parse");
  assert.equal(classifyError(null, "socket hang up"), "network");
});

// ─── formatter.js: extension detection ───────────────────────────────────────
test("getExtension returns the lowercase extension", () => {
  assert.equal(getExtension("src/App.TSX"), ".tsx");
  assert.equal(getExtension("styles/main.css"), ".css");
  assert.equal(getExtension("README"), "");
  assert.equal(getExtension("a/b.min.js"), ".js");
});

// ─── config.js: env-var precedence ───────────────────────────────────────────
test("getApiKey prefers the GEMINI_API_KEY env var", () => {
  const prev = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "env-key-abc";
  try {
    assert.equal(getApiKey(), "env-key-abc");
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prev;
  }
});
