import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModel } from "../src/ai.js";
import { getApiKey } from "../src/config.js";

// Live reachability check. Skipped unless an API key is available (env var or
// saved config), so it never blocks contributors who don't have a key.
//
// In CI, add a GEMINI_API_KEY secret to make this run — it is the guard that
// would have caught the v1.0 outage where the default model was retired for new
// keys and every call silently fell back to generic messages.
const apiKey = getApiKey();

test(
  "the model chain has no retired-model or bad-key problem",
  { skip: apiKey ? false : "no GEMINI_API_KEY / saved key available" },
  async () => {
    const result = await checkModel(apiKey);
    if (result.ok) return;
    // Quota/timeout/network are transient — don't fail CI on a throttle or blip.
    // But a retired model or rejected key is exactly what this test exists to
    // catch, so fail loudly on those.
    assert.ok(
      result.kind !== "modelNotFound" && result.kind !== "invalidKey",
      `model/key problem: kind=${result.kind} (${result.message})`,
    );
  },
);
