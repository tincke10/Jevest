import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewPublication } from "../../domain/ports/vcs-port.js";
import type { PullRequestRef } from "../../domain/pull-request.js";
import {
  createGitFileContentFetcher,
  createLocalDiffVcsAdapter,
  parseUnifiedDiff,
} from "./local-diff-vcs-adapter.js";

const ref: PullRequestRef = {
  owner: "local",
  repo: "local",
  number: 0,
  headSha: "head",
  baseSha: "base",
};

describe("parseUnifiedDiff", () => {
  it("parses a single modified file, counting additions and deletions from the patch", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index abc123..def456 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      " context",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/a.ts");
    expect(files[0]!.status).toBe("modified");
    expect(files[0]!.additions).toBe(1);
    expect(files[0]!.deletions).toBe(1);
    expect(files[0]!.patch).toContain("@@ -1,2 +1,2 @@");
  });

  it("marks a new file (--- /dev/null) as added", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..abc123",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files[0]!.status).toBe("added");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(0);
  });

  it("marks a deleted file (+++ /dev/null) as removed", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "index abc123..0000000",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-line one",
      "-line two",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files[0]!.status).toBe("removed");
  });

  it("marks a pure rename (no content hunks) as renamed", () => {
    const diff = [
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 100%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("src/new-name.ts");
    expect(files[0]!.status).toBe("renamed");
  });

  it("parses multiple files from one diff", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "index 3..4 100644",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,1 @@",
      "-p",
      "+q",
    ].join("\n");

    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0]!.path).toBe("a.ts");
    expect(files[1]!.path).toBe("b.ts");
  });

  it("returns an empty array for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("createLocalDiffVcsAdapter", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jevest-local-vcs-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fetches a pull request from a local diff file", async () => {
    const diffPath = join(dir, "change.diff");
    await writeFile(
      diffPath,
      ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1,1 +1,1 @@", "-x", "+y"].join(
        "\n",
      ),
      "utf8",
    );

    const adapter = createLocalDiffVcsAdapter({
      source: { type: "file", path: diffPath },
      outDir: join(dir, "out"),
      title: "Local review",
      body: "A local diff.",
    });

    const pr = await adapter.fetchPullRequest(ref);
    expect(pr.ref).toEqual(ref);
    expect(pr.title).toBe("Local review");
    expect(pr.body).toBe("A local diff.");
    expect(pr.files).toHaveLength(1);
    expect(pr.files[0]!.path).toBe("a.ts");
  });

  it("writes review.md and review.json to the output directory when publishing", async () => {
    const diffPath = join(dir, "change.diff");
    await writeFile(diffPath, "", "utf8");
    const outDir = join(dir, "out");
    const adapter = createLocalDiffVcsAdapter({
      source: { type: "file", path: diffPath },
      outDir,
    });

    const publication: ReviewPublication = {
      summaryMarkdown: "## Summary\nAll good.",
      summaryFingerprint: "fp1",
      inlineComments: [],
      labelsToAdd: ["jevest:auto-merge-ok"],
      labelsToRemove: [],
      check: { conclusion: "success", title: "Jevest: success", summary: "ok" },
    };

    await adapter.publishReview(ref, publication);

    const md = await readFile(join(outDir, "review.md"), "utf8");
    const json = JSON.parse(await readFile(join(outDir, "review.json"), "utf8"));
    expect(md).toBe("## Summary\nAll good.");
    expect(json).toEqual(publication);
  });

  it("fetches a pull request via a git diff range, using an injected git runner", async () => {
    const gitDiffOutput = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
    ].join("\n");
    let capturedArgs: readonly string[] | undefined;
    const runGit = async (args: readonly string[]): Promise<string> => {
      capturedArgs = args;
      return gitDiffOutput;
    };

    const adapter = createLocalDiffVcsAdapter({
      source: { type: "git-range", repoDir: dir, base: "main", head: "HEAD" },
      outDir: join(dir, "out"),
      runGit,
    });

    const pr = await adapter.fetchPullRequest(ref);
    expect(pr.files).toHaveLength(1);
    expect(capturedArgs).toEqual(["diff", "main...HEAD"]);
  });
});

describe("createGitFileContentFetcher", () => {
  it("returns file content via an injected git runner", async () => {
    const runGit = async (args: readonly string[]): Promise<string> => {
      expect(args).toEqual(["show", "abc123:src/a.ts"]);
      return "export function f() {}\n";
    };
    const fetcher = createGitFileContentFetcher("/repo", runGit);
    const content = await fetcher("src/a.ts", "abc123");
    expect(content).toBe("export function f() {}\n");
  });

  it("returns null when git show fails (e.g. file did not exist at that sha)", async () => {
    const runGit = async (): Promise<string> => {
      throw new Error("fatal: path does not exist");
    };
    const fetcher = createGitFileContentFetcher("/repo", runGit);
    const content = await fetcher("src/missing.ts", "abc123");
    expect(content).toBeNull();
  });
});
