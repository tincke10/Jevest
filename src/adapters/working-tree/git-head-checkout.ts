/**
 * A working tree at the PR head for a local run (`pnpm review --git`,
 * `pnpm eval:review`), so the code-context layers and the evidence check
 * read the code the diff produced, not whatever the repo has checked out.
 *
 * - The repo is non-bare, clean (tracked files), and HEAD is the head:
 *   used in place (`kind: "in-place"`); cleanup does nothing.
 * - Otherwise (bare, another commit, local edits): a temporary
 *   `git worktree add --detach <tmp> <head>` (`kind: "worktree"`), removed
 *   by `cleanup()` — call it in a `finally`.
 * - A blob-filtered mirror (`--filter=blob:none`) may lack some blobs of the
 *   head tree; a plain checkout would then try to fetch them. Every git call
 *   here runs with `GIT_NO_LAZY_FETCH=1` (never touches the network, never
 *   hangs on a promisor remote), the missing blobs are counted first with
 *   `git cat-file --batch-check`, and when there are any the worktree is
 *   added with `--no-checkout` and only the present files are checked out
 *   (`kind: "partial-worktree"`, `skippedFiles` says how many were left
 *   out). Measured on a real blob-filtered mirror: the missing blobs were
 *   images, video and fixtures, never the source the search needs.
 *
 * Any git failure is an Error naming the repo and the head; nothing waits
 * on a prompt (`GIT_TERMINAL_PROMPT=0`) and each call has a timeout.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface HeadCheckout {
  /** Absolute path of a tree whose files are the head's. */
  readonly root: string;
  readonly kind: "in-place" | "worktree" | "partial-worktree";
  /** Files of the head tree left out because their blob is not in the local object store. */
  readonly skippedFiles: number;
  /** Files (blobs) in the head tree. */
  readonly totalFiles: number;
  /** Removes a temporary worktree; never throws. */
  cleanup(): Promise<void>;
}

export interface PrepareHeadCheckoutOptions {
  readonly repoDir: string;
  /** A commit-ish: the PR head. */
  readonly head: string;
  /** Where the temporary worktree goes; default the OS temp dir. */
  readonly tmpParent?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LITERAL_PATHSPECS: "1",
};

function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args as string[], { cwd, env: GIT_ENV });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `git ${args[0]} ${signal ? `killed (${signal})` : `exited ${code}`}: ${stderr.trim().slice(0, 500)}`,
          ),
        );
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

interface TreeFile {
  readonly blob: string;
  readonly path: string;
}

/** `git ls-tree -r -z` output -> the head's files (submodules skipped). */
function parseLsTree(output: string): TreeFile[] {
  const files: TreeFile[] = [];
  for (const entry of output.split("\0")) {
    if (entry === "") continue;
    const tab = entry.indexOf("\t");
    const [, type, blob] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || blob === undefined) continue;
    files.push({ blob, path: entry.slice(tab + 1) });
  }
  return files;
}

async function missingBlobs(
  repoDir: string,
  files: readonly TreeFile[],
  timeoutMs: number,
): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const unique = [...new Set(files.map((f) => f.blob))];
  const output = await runGit(
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    repoDir,
    timeoutMs,
    `${unique.join("\n")}\n`,
  );
  const missing = new Set<string>();
  for (const line of output.split("\n")) {
    const [name, status] = line.split(" ");
    if (name && status === "missing") missing.add(name);
  }
  return missing;
}

async function isInPlaceUsable(
  repoDir: string,
  sha: string,
  timeoutMs: number,
): Promise<string | null> {
  const bare = (await runGit(["rev-parse", "--is-bare-repository"], repoDir, timeoutMs)).trim();
  if (bare === "true") return null;
  try {
    const current = (await runGit(["rev-parse", "HEAD"], repoDir, timeoutMs)).trim();
    if (current !== sha) return null;
    const dirty = await runGit(
      ["status", "--porcelain", "--untracked-files=no"],
      repoDir,
      timeoutMs,
    );
    if (dirty.trim() !== "") return null;
    return (await runGit(["rev-parse", "--show-toplevel"], repoDir, timeoutMs)).trim();
  } catch {
    return null;
  }
}

/** A tree at `head` for `repoDir` (see the module doc). */
export async function prepareHeadCheckout(
  options: PrepareHeadCheckoutOptions,
): Promise<HeadCheckout> {
  const { repoDir, head } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fail = (step: string, error: unknown): Error =>
    new Error(
      `cannot check out ${head} from ${repoDir} (${step}): ${error instanceof Error ? error.message : String(error)}`,
    );

  let sha: string;
  try {
    sha = (await runGit(["rev-parse", "--verify", `${head}^{commit}`], repoDir, timeoutMs)).trim();
  } catch (error) {
    throw fail("resolve head", error);
  }

  let files: TreeFile[];
  let missing: Set<string>;
  try {
    files = parseLsTree(
      await runGit(["ls-tree", "-r", "-z", "--full-tree", sha], repoDir, timeoutMs),
    );
    missing = await missingBlobs(repoDir, files, timeoutMs);
  } catch (error) {
    throw fail("list the head tree", error);
  }
  const present = files.filter((f) => !missing.has(f.blob));
  const skippedFiles = files.length - present.length;

  const inPlace = await isInPlaceUsable(repoDir, sha, timeoutMs);
  if (inPlace !== null) {
    return {
      root: inPlace,
      kind: "in-place",
      skippedFiles: 0,
      totalFiles: files.length,
      cleanup: async () => {},
    };
  }

  const parent = await mkdtemp(join(options.tmpParent ?? tmpdir(), "jevest-head-"));
  const root = join(parent, "tree");
  const cleanup = async (): Promise<void> => {
    try {
      await runGit(["worktree", "remove", "--force", root], repoDir, timeoutMs);
    } catch {
      // Fall through: the directory is removed below and the entry pruned.
    }
    await rm(parent, { recursive: true, force: true });
    try {
      await runGit(["worktree", "prune"], repoDir, timeoutMs);
    } catch {
      // Best effort.
    }
  };

  try {
    if (skippedFiles === 0) {
      await runGit(["worktree", "add", "--detach", root, sha], repoDir, timeoutMs);
    } else {
      await runGit(["worktree", "add", "--detach", "--no-checkout", root, sha], repoDir, timeoutMs);
      if (present.length > 0) {
        await runGit(
          ["checkout", sha, "--pathspec-from-file=-", "--pathspec-file-nul"],
          root,
          timeoutMs,
          `${present.map((f) => f.path).join("\0")}\0`,
        );
      }
    }
  } catch (error) {
    await cleanup();
    throw fail("git worktree add", error);
  }

  return {
    root,
    kind: skippedFiles === 0 ? "worktree" : "partial-worktree",
    skippedFiles,
    totalFiles: files.length,
    cleanup,
  };
}
