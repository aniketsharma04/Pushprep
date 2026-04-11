import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.pushprep');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Reads the config file. Returns {} on missing or corrupt file.
 */
function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Writes an object to the config file, creating the directory if needed.
 */
function writeConfig(data) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Saves the Gemini API key to ~/.pushprep/config.json
 */
export function saveApiKey(key) {
  const config = readConfig();
  config.geminiApiKey = key;
  writeConfig(config);
}

/**
 * Returns the saved Gemini API key, or null if not set.
 */
export function getApiKey() {
  const config = readConfig();
  return config.geminiApiKey || null;
}

/**
 * Removes the API key from config.
 */
export function removeApiKey() {
  const config = readConfig();
  delete config.geminiApiKey;
  writeConfig(config);
}

/**
 * Returns a masked version of the key for display.
 * e.g. AIzaSy••••••••••••y8Xz
 */
function maskKey(key) {
  if (!key || key.length < 12) return '••••••••••••••••';
  return key.slice(0, 6) + '•'.repeat(key.length - 10) + key.slice(-4);
}

/**
 * Prints the masked API key and config file path to stdout.
 */
export function showConfig() {
  const key = getApiKey();
  if (!key) {
    return { hasKey: false, configPath: CONFIG_FILE };
  }
  return { hasKey: true, maskedKey: maskKey(key), configPath: CONFIG_FILE };
}
