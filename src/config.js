import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_DIR = path.join(os.homedir(), ".pushprep");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function getConfigPath() {
  return CONFIG_FILE;
}

/**
 * Reads and normalizes the config file to the v2 shape:
 *   { provider, keys: {}, models: {}, tips }
 * Returns a normalized object on missing or corrupt file. v1 configs (a bare
 * `geminiApiKey` string) are migrated in-memory so old installs keep working;
 * the migrated shape is persisted the next time anything is written.
 */
function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    raw = {};
  }

  const config = {
    provider: raw.provider || null,
    keys: { ...(raw.keys || {}) },
    models: { ...(raw.models || {}) },
    tips: raw.tips,
  };

  // v1 → v2 migration: a single geminiApiKey became keys.gemini.
  if (raw.geminiApiKey && !config.keys.gemini) {
    config.keys.gemini = raw.geminiApiKey;
    if (!config.provider) config.provider = "gemini";
  }

  return config;
}

/**
 * Writes the normalized v2 config, creating the directory if needed. Drops any
 * lingering v1 `geminiApiKey` field since loadConfig has already migrated it.
 */
function writeConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const out = {
    provider: config.provider || undefined,
    keys: config.keys && Object.keys(config.keys).length ? config.keys : {},
    models:
      config.models && Object.keys(config.models).length ? config.models : {},
    tips: config.tips,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), "utf-8");
}

// ─── Active provider ─────────────────────────────────────────────────────────
/**
 * The provider to use. PUSHPREP_PROVIDER env var wins (handy for CI / one-offs),
 * then the saved config. Returns null if nothing is set (caller picks a default).
 */
export function getActiveProviderId() {
  const env = process.env.PUSHPREP_PROVIDER;
  if (env && env.trim()) return env.trim().toLowerCase();
  return loadConfig().provider || null;
}

export function setActiveProvider(id) {
  const config = loadConfig();
  config.provider = id;
  writeConfig(config);
}

// ─── Per-provider keys ───────────────────────────────────────────────────────
/**
 * Resolves a provider's API key. The provider's own env vars (passed in as
 * envKeys) take precedence over the saved config, so CI and one-off overrides
 * work without touching the config file. Returns null if none is set.
 */
export function resolveKey(envKeys, providerId) {
  for (const name of envKeys || []) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  const stored = loadConfig().keys[providerId];
  return stored && stored.trim() ? stored.trim() : null;
}

/** The key stored in config for a provider (ignores env vars). */
export function getStoredKey(providerId) {
  return loadConfig().keys[providerId] || null;
}

export function saveProviderKey(providerId, key) {
  const config = loadConfig();
  config.keys[providerId] = key;
  writeConfig(config);
}

export function removeProviderKey(providerId) {
  const config = loadConfig();
  delete config.keys[providerId];
  writeConfig(config);
}

// ─── Per-provider model override ─────────────────────────────────────────────
export function getStoredModel(providerId) {
  return loadConfig().models[providerId] || null;
}

export function setStoredModel(providerId, model) {
  const config = loadConfig();
  if (model) config.models[providerId] = model;
  else delete config.models[providerId];
  writeConfig(config);
}

// ─── Tips toggle ─────────────────────────────────────────────────────────────
/**
 * Whether to show the subtle one-line UI tips. Default on. Disable persistently
 * via config, or per-run with PUSHPREP_TIPS=0 (useful for CI / quiet output).
 */
export function getTipsEnabled() {
  if (process.env.PUSHPREP_TIPS === "0") return false;
  return loadConfig().tips !== false;
}

export function setTipsEnabled(enabled) {
  const config = loadConfig();
  config.tips = enabled;
  writeConfig(config);
}

// ─── Display helpers ─────────────────────────────────────────────────────────
/**
 * Masks a key for display, e.g. AIzaSy••••••••••••y8Xz
 */
export function maskKey(key) {
  if (!key || key.length < 12) return "••••••••••••••••";
  return key.slice(0, 6) + "•".repeat(key.length - 10) + key.slice(-4);
}

/**
 * A snapshot of the current config for `pushprep config --show`.
 */
export function getConfigSummary() {
  const config = loadConfig();
  return {
    provider: config.provider || null,
    keys: config.keys,
    models: config.models,
    tips: config.tips !== false,
    configPath: CONFIG_FILE,
  };
}

// ─── Legacy Gemini-focused API (kept for back-compat + tests) ────────────────
/**
 * Resolves the Gemini key. Precedence: GEMINI_API_KEY / PUSHPREP_API_KEY env
 * vars over the saved config. Returns null if none is set.
 */
export function getApiKey() {
  return resolveKey(["GEMINI_API_KEY", "PUSHPREP_API_KEY"], "gemini");
}

/** Saves a Gemini API key (legacy single-key path). */
export function saveApiKey(key) {
  saveProviderKey("gemini", key);
}

/** Removes the Gemini API key (legacy single-key path). */
export function removeApiKey() {
  removeProviderKey("gemini");
}

/** Legacy masked-key view used by the old `config --show` path. */
export function showConfig() {
  const key = getApiKey();
  if (!key) return { hasKey: false, configPath: CONFIG_FILE };
  return { hasKey: true, maskedKey: maskKey(key), configPath: CONFIG_FILE };
}
