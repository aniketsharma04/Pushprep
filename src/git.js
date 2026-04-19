import simpleGit from "simple-git";

const git = simpleGit();

/**
 * Returns true if the current directory is inside a git repository.
 */
export async function isGitRepo() {
  try {
    await git.status();
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the full git status object from simple-git.
 */
export async function getGitStatus() {
  return await git.status();
}

/**
 * Returns all changed files: modified + untracked + deleted (unstaged).
 * These are the files that need formatting / staging.
 */
export async function getAllChangedFiles() {
  const status = await git.status();
  const changed = [
    ...status.modified,
    ...status.not_added,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];
  // Deduplicate
  return [...new Set(changed)];
}

/**
 * Returns files currently in the git staging area.
 */
export async function getStagedFiles() {
  const status = await git.status();
  return [
    ...status.staged,
    ...status.created,
    ...status.renamed.map((r) => r.to),
  ].filter((f) => {
    // simple-git stages show as 'index_...' in raw — staged array is reliable
    return true;
  });
}

/**
 * Stages all changed files (git add .).
 */
export async function stageAllFiles() {
  await git.add(".");
}

/**
 * Stages specific files by path array.
 * @param {string[]} files
 */
export async function stageSpecificFiles(files) {
  await git.add(files);
}

/**
 * Returns the staged diff (git diff --staged).
 */
export async function getDiff() {
  return await git.diff(["--staged"]);
}

/**
 * Commits with the given message.
 * @param {string} message
 */
export async function commitWithMessage(message) {
  await git.commit(message);
}
