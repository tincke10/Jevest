/**
 * VcsPort for running the pipeline locally (SPEC §5 Fase 1b), without a
 * real GitHub PR: `fetchPullRequest` reads a unified diff — either a file
 * on disk or `git diff <base>...<head>` in a repo — and `publishReview`
 * writes the result to `review.md`/`review.json` in an output directory
 * instead of calling any VCS API. The git invocation is always injectable
 * (`options.runGit`), same pattern as `ClaudeCliSpawn` in
 * ../reviewers/claude-cli-reviewer.ts, so tests never spawn a real process.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewPublication, VcsPort } from "../../domain/ports/vcs-port.js";
import type {
  PullRequestData,
  PullRequestFile,
  PullRequestRef,
} from "../../domain/pull-request.js";

const execFileAsync = promisify(execFile);

/** Runs `git <args>` and returns stdout; the default implementation shells out via `node:child_process.execFile`. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

async function defaultRunGit(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const DIFF_HEADER_RE = /^diff --git a\/(.*) b\/(.*)$/;

/**
 * Parses a multi-file unified diff (e.g. `git diff` output) into
 * `PullRequestFile[]`. Additions/deletions are counted in code from the
 * patch body (NFR-5: never hand a raw count to Jev, but the count itself is
 * still computed here, before anything is asked).
 */
export function parseUnifiedDiff(diff: string): PullRequestFile[] {
  if (!diff.trim()) {
    return [];
  }

  const lines = diff.split("\n");
  const files: PullRequestFile[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerLine = lines[i];
    const match = headerLine !== undefined ? DIFF_HEADER_RE.exec(headerLine) : null;
    if (!match) {
      i++;
      continue;
    }

    const bLine = match[2];
    if (bLine === undefined) {
      // The regex always has group 2 participate on a match; this is
      // unreachable, but keeps the parser assertion-free.
      i++;
      continue;
    }
    // Only the hunk lines (from the first `@@` onward) go into `patch`,
    // matching GitHub's own `PullRequestFile.patch` shape — it never
    // includes the `diff --git`/`index`/`---`/`+++`/rename preamble git's
    // own CLI output adds.
    const patchLines: string[] = [];
    i++;

    let isNew = false;
    let isDeleted = false;
    let isRename = false;
    let renamedTo: string | null = null;
    let additions = 0;
    let deletions = 0;
    let sawHunk = false;

    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || DIFF_HEADER_RE.test(line)) break;

      if (line.startsWith("new file mode")) isNew = true;
      else if (line.startsWith("deleted file mode")) isDeleted = true;
      else if (line.startsWith("rename from")) isRename = true;
      else if (line.startsWith("rename to ")) renamedTo = line.slice("rename to ".length);
      else if (line.startsWith("--- /dev/null")) isNew = true;
      else if (line.startsWith("+++ /dev/null")) isDeleted = true;
      else if (line.startsWith("@@")) sawHunk = true;
      else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;

      if (sawHunk) {
        patchLines.push(line);
      }

      i++;
    }

    const status: PullRequestFile["status"] = isNew
      ? "added"
      : isDeleted
        ? "removed"
        : isRename && !sawHunk
          ? "renamed"
          : "modified";

    files.push({
      path: renamedTo ?? bLine,
      status,
      additions,
      deletions,
      ...(patchLines.length > 0 ? { patch: patchLines.join("\n") } : {}),
    });
  }

  return files;
}

export type LocalDiffSource =
  | { readonly type: "file"; readonly path: string }
  | {
      readonly type: "git-range";
      readonly repoDir: string;
      readonly base: string;
      readonly head: string;
    };

export interface LocalDiffVcsAdapterOptions {
  readonly source: LocalDiffSource;
  /** Directory `publishReview` writes `review.md`/`review.json` into. */
  readonly outDir: string;
  readonly title?: string;
  readonly body?: string;
  readonly author?: string;
  readonly labels?: readonly string[];
  readonly baseBranch?: string;
  readonly ciStatus?: PullRequestData["ciStatus"];
  /** Injectable for tests; default wraps `node:child_process.execFile("git", ...)`. */
  readonly runGit?: GitRunner;
}

export function createLocalDiffVcsAdapter(options: LocalDiffVcsAdapterOptions): VcsPort {
  const runGit = options.runGit ?? defaultRunGit;

  return {
    async fetchPullRequest(ref: PullRequestRef): Promise<PullRequestData> {
      const diffText =
        options.source.type === "file"
          ? await readFile(options.source.path, "utf8")
          : await runGit(
              ["diff", `${options.source.base}...${options.source.head}`],
              options.source.repoDir,
            );

      return {
        ref,
        title: options.title ?? "Local review",
        body: options.body ?? "",
        author: options.author ?? "local",
        labels: options.labels ? [...options.labels] : [],
        baseBranch: options.baseBranch ?? "main",
        files: parseUnifiedDiff(diffText),
        ciStatus: options.ciStatus ?? "unknown",
      };
    },

    async publishReview(_ref: PullRequestRef, publication: ReviewPublication): Promise<void> {
      await mkdir(options.outDir, { recursive: true });
      await writeFile(join(options.outDir, "review.md"), publication.summaryMarkdown, "utf8");
      await writeFile(
        join(options.outDir, "review.json"),
        `${JSON.stringify(publication, null, 2)}\n`,
        "utf8",
      );
    },
  };
}

/**
 * Optional `fetchFileContent` for hunk-profile's §4.3 full-file AST context,
 * via `git show <sha>:<path>`. Not part of the shared VcsPort contract —
 * threaded separately into `runPipeline`'s input, since only a git-backed
 * source can supply it (a plain diff file cannot).
 */
export function createGitFileContentFetcher(
  repoDir: string,
  runGit: GitRunner = defaultRunGit,
): (path: string, sha: string) => Promise<string | null> {
  return async (path: string, sha: string): Promise<string | null> => {
    try {
      return await runGit(["show", `${sha}:${path}`], repoDir);
    } catch {
      return null;
    }
  };
}
