import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

// ─── Self-update ─────────────────────────────────────────────────────────────
// Keeps a globally-installed pushprep current without the user thinking about
// it: on a normal run we check (at most a few times a day) whether a newer
// version is published, and if so install it and re-exec the same command on
// the new code. Every step is best-effort — offline, no permissions, a dev
// checkout, or CI all fall through silently to the current version so the actual
// workflow never breaks.

const CACHE_FILE = path.join(os.homedir(), ".pushprep", "update-check.json");
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // re-query the registry at most every 6h
const REGISTRY_URL = "https://registry.npmjs.org/pushprep/latest";
const NETWORK_TIMEOUT_MS = 3000; // never hang a run waiting on the registry

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
  } catch {
    // A read-only home dir shouldn't break the tool — just skip caching.
  }
}

/**
 * True if `latest` is a strictly higher x.y.z version than `current`.
 * Deliberately simple: published versions are plain semver.
 */
export function isNewer(current, latest) {
  if (typeof current !== "string" || typeof latest !== "string") return false;
  const a = current.split(".").map((n) => parseInt(n, 10) || 0);
  const b = latest.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((b[i] || 0) > (a[i] || 0)) return true;
    if ((b[i] || 0) < (a[i] || 0)) return false;
  }
  return false;
}

async function fetchLatest() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null; // offline / timeout / bad response — caller falls back
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Only auto-update genuine global installs. A source checkout (`node
 * src/cli.js`) or a linked dev copy lives outside node_modules — updating it
 * would clobber the user's working tree, so we never do.
 */
function isGlobalInstall(scriptPath) {
  return scriptPath.includes(`${path.sep}node_modules${path.sep}`);
}

function shouldSkip(scriptPath) {
  return (
    process.env.PUSHPREP_UPDATED === "1" || // re-exec guard — already on latest
    process.env.PUSHPREP_NO_UPDATE === "1" || // explicit opt-out
    !!process.env.CI || // never mutate global installs in CI
    !isGlobalInstall(scriptPath)
  );
}

/**
 * Resolves the version pushprep should be on, using the cached result when it's
 * fresh so most runs make no network call at all. Returns null when unknown.
 */
async function resolveLatest() {
  const cache = readCache();
  const now = Date.now();
  if (
    cache &&
    cache.latest &&
    now - (cache.checkedAt || 0) < CHECK_INTERVAL_MS
  ) {
    return cache.latest;
  }
  const latest = await fetchLatest();
  if (latest) {
    writeCache({ checkedAt: now, latest });
    return latest;
  }
  // Offline: fall back to whatever we last knew (may still trigger an update).
  return cache?.latest || null;
}

/**
 * Best-effort self-update. If a newer version is published, installs it globally
 * and re-execs the same command on the new code, then exits the current process.
 * Returns (without updating) on any problem so the caller proceeds normally.
 *
 * @param {string} currentVersion  the running package version
 * @param {(event: {phase: "start"|"done"|"fail", version: string}) => void} [onStatus]
 */
export async function maybeAutoUpdate(currentVersion, onStatus = () => {}) {
  try {
    const scriptPath = process.argv[1] || "";
    if (shouldSkip(scriptPath)) return;

    const latest = await resolveLatest();
    if (!latest || !isNewer(currentVersion, latest)) return;

    onStatus({ phase: "start", version: latest });
    const install = spawnSync("npm", ["install", "-g", `pushprep@${latest}`], {
      stdio: "ignore",
      // npm is a .cmd shim on Windows, which needs a shell to resolve.
      shell: process.platform === "win32",
    });
    if (install.status !== 0) {
      onStatus({ phase: "fail", version: latest });
      return; // couldn't update (perms, network) — run the current version
    }
    onStatus({ phase: "done", version: latest });

    // npm overwrote the script at the same path, so re-running node on it
    // executes the freshly-installed version. Inherit stdio so interactive
    // prompts keep working; the guard env var stops the child re-checking.
    const child = spawnSync(
      process.execPath,
      [scriptPath, ...process.argv.slice(2)],
      { stdio: "inherit", env: { ...process.env, PUSHPREP_UPDATED: "1" } },
    );
    process.exit(child.status ?? 0);
  } catch {
    // Auto-update must never break the real workflow — swallow everything.
  }
}
