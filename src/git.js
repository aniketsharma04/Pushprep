import simpleGit from "simple-git";
import { execFileSync } from "child_process";

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
  const { staged } = await getChangeSets();
  return staged;
}

/**
 * Accurately splits the working tree into staged vs unstaged files using the
 * porcelain per-file codes (index = staged change, working_dir = unstaged
 * change). This avoids simple-git's convenience arrays, where a staged tracked
 * file appears in BOTH `modified` and `staged` — which made the status display
 * list the same file under "Unstaged" and "Already staged" at once.
 *
 * A file legitimately appears in both lists only when it has partially staged
 * changes (some hunks staged, later edits not).
 *
 * @returns {Promise<{ staged: string[], unstaged: string[] }>}
 */
export async function getChangeSets() {
  const status = await git.status();
  const staged = [];
  const unstaged = [];

  for (const f of status.files) {
    const indexCode = f.index; // change staged in the index (' ' = none, '?' = untracked)
    const workCode = f.working_dir; // change in the working tree ('?' = untracked)

    if (workCode && workCode !== " ") unstaged.push(f.path);
    if (indexCode && indexCode !== " " && indexCode !== "?")
      staged.push(f.path);
  }

  return {
    staged: [...new Set(staged)],
    unstaged: [...new Set(unstaged)],
  };
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
 * Synchronously unstages exactly the given files — used to undo the staging
 * pushprep did this run when the user aborts (Ctrl+C) or picks "revert". Runs
 * synchronously (via execFileSync) so it can complete inside a Ctrl+C / SIGINT
 * handler before the process exits — an async simple-git call would be cut off
 * by process.exit().
 *
 * Only the listed paths are unstaged (`git reset -- <paths>`), so any files the
 * user had staged before running pushprep — and that pushprep never touched —
 * stay staged. Working-tree contents are never modified. Best-effort: any
 * failure is swallowed so a cancel never turns into a crash.
 *
 * @param {string[]} files - files pushprep staged this run
 */
export function unstageFilesSync(files = []) {
  if (!files.length) return;
  try {
    execFileSync("git", ["reset", "-q", "--", ...files], { stdio: "ignore" });
  } catch {
    // Never let cleanup crash the exit path.
  }
}

/**
 * Returns the staged diff (git diff --staged).
 */
export async function getDiff() {
  return await git.diff(["--staged"]);
}

/**
 * Returns a per-file summary of the staged changes (git diff --staged --stat).
 * Passed to the AI alongside the diff so multi-file commits are always described
 * in full — even when the raw diff is truncated for length.
 */
export async function getDiffStat() {
  return await git.diff(["--staged", "--stat"]);
}

/**
 * Commits with the given message.
 * @param {string} message
 */
export async function commitWithMessage(message) {
  await git.commit(message);
}

/**
 * Amends the previous commit, replacing its message (and folding in any
 * currently staged changes).
 * @param {string} message
 */
export async function amendWithMessage(message) {
  await git.commit(message, { "--amend": null });
}

/**
 * Returns true if the repo has at least one commit (HEAD resolves).
 */
export async function hasCommits() {
  try {
    await git.revparse(["HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the subject line of the previous (HEAD) commit, or "" if none.
 */
export async function getLastCommitMessage() {
  try {
    return (await git.raw(["log", "-1", "--pretty=%s"])).trim();
  } catch {
    return "";
  }
}

/**
 * Returns the diff introduced by the previous commit (HEAD~1..HEAD), used to
 * regenerate a message when amending. Falls back to the diff of the root commit
 * when there is no parent.
 */
export async function getLastCommitDiff() {
  try {
    return await git.diff(["HEAD~1", "HEAD"]);
  } catch {
    // Root commit — diff against the empty tree.
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    return await git.diff([EMPTY_TREE, "HEAD"]);
  }
}

/**
 * Returns the list of files touched by the previous (HEAD) commit.
 */
export async function getLastCommitFiles() {
  try {
    const out = await git.raw([
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]);
    return out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns the current branch name (or "" when detached / unknown).
 */
export async function getCurrentBranch() {
  try {
    const status = await git.status();
    return status.current || "";
  } catch {
    return "";
  }
}

/**
 * Pushes the current branch to its upstream. If no upstream is set, sets it to
 * origin/<branch> on the first push. Returns { ok, message }.
 */
export async function pushCurrent() {
  try {
    const branch = await getCurrentBranch();
    try {
      await git.push();
    } catch (err) {
      const msg = (err?.message || "").toLowerCase();
      // No upstream configured yet — establish it against origin.
      if (msg.includes("no upstream") || msg.includes("set-upstream")) {
        await git.push(["-u", "origin", branch]);
      } else {
        throw err;
      }
    }
    return { ok: true, message: branch };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
}
