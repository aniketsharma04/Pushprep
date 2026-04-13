import fs from "fs";
import prettier from "prettier";

/**
 * All file extensions Prettier can format.
 * Per PRD §4.2.1
 */
const SUPPORTED_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".mdx",
  ".graphql",
  ".gql",
]);

/**
 * Returns the lowercase extension of a file path.
 * @param {string} filePath
 */
function getExtension(filePath) {
  const idx = filePath.lastIndexOf(".");
  if (idx === -1) return "";
  return filePath.slice(idx).toLowerCase();
}

/**
 * Formats a list of changed files with Prettier.
 * Only processes files with supported extensions.
 * Respects the project's .prettierrc / prettier.config.js.
 *
 * @param {string[]} files - list of relative file paths
 * @returns {{ formatted: string[], skipped: string[], failed: string[] }}
 */
export async function formatFiles(files) {
  const formatted = [];
  const alreadyClean = []; // formatted correctly — shown as "Already clean"
  const failed = []; // prettier threw — shown as warning
  // Files Prettier can't parse or don't exist are silently ignored (PRD §4.2.3)

  const formattable = files.filter((f) =>
    SUPPORTED_EXTENSIONS.has(getExtension(f)),
  );

  for (const filePath of formattable) {
    try {
      // Check if the file exists on disk (may have been deleted)
      if (!fs.existsSync(filePath)) continue;

      // Ask Prettier if it can parse this file — silently skip if not
      const fileInfo = await prettier.getFileInfo(filePath);
      if (fileInfo.ignored || !fileInfo.inferredParser) continue;

      const original = fs.readFileSync(filePath, "utf-8");

      // Resolve project-level config, fall back to Prettier defaults
      const config = await prettier.resolveConfig(filePath);

      const result = await prettier.format(original, {
        ...config,
        filepath: filePath,
      });

      if (result === original) {
        alreadyClean.push(filePath);
      } else {
        fs.writeFileSync(filePath, result, "utf-8");
        formatted.push(filePath);
      }
    } catch (err) {
      // Per PRD §4.2.3: show warning but do NOT abort workflow
      failed.push(filePath);
    }
  }

  return { formatted, alreadyClean, failed };
}
