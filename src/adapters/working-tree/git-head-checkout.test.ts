import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareHeadCheckout } from "./git-head-checkout.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  }).trim();
}

describe("prepareHeadCheckout (real git)", () => {
  let base = "";
  let repo = "";
  let first = "";
  let second = "";

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "jevest-checkout-"));
    repo = join(base, "repo");
    git(base, "init", "-q", repo);
    await writeFile(join(repo, "a.ts"), "export const version = 1;\n");
    await writeFile(join(repo, "logo.png"), "binary-ish v1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    first = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "a.ts"), "export const version = 2;\n");
    await writeFile(join(repo, "logo.png"), "binary-ish v2\n");
    git(repo, "commit", "-q", "-am", "second");
    second = git(repo, "rev-parse", "HEAD");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("uses the repo in place when it is checked out, clean, at the head", async () => {
    const checkout = await prepareHeadCheckout({ repoDir: repo, head: second });
    expect(checkout.kind).toBe("in-place");
    expect(await readFile(join(checkout.root, "a.ts"), "utf8")).toContain("version = 2");
    await checkout.cleanup();
    expect(existsSync(join(repo, "a.ts"))).toBe(true);
  });

  it("adds a temporary detached worktree when HEAD is not the head, and removes it", async () => {
    const tmpParent = await mkdtemp(join(base, "wt-"));
    const checkout = await prepareHeadCheckout({ repoDir: repo, head: first, tmpParent });
    expect(checkout.kind).toBe("worktree");
    expect(checkout.root.startsWith(tmpParent)).toBe(true);
    expect(await readFile(join(checkout.root, "a.ts"), "utf8")).toContain("version = 1");
    expect(checkout.skippedFiles).toBe(0);
    await checkout.cleanup();
    expect(existsSync(checkout.root)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(checkout.root);
  });

  it("works on a bare repository", async () => {
    const bare = join(base, "bare.git");
    git(base, "clone", "-q", "--bare", repo, bare);
    const checkout = await prepareHeadCheckout({ repoDir: bare, head: second });
    expect(checkout.kind).toBe("worktree");
    expect(await readFile(join(checkout.root, "a.ts"), "utf8")).toContain("version = 2");
    await checkout.cleanup();
    expect(git(bare, "worktree", "list")).not.toContain(checkout.root);
  });

  it("checks out only the files whose blobs are present, and says how many it skipped", async () => {
    const bare = join(base, "partial.git");
    git(base, "clone", "-q", "--bare", "--no-local", repo, bare);
    git(bare, "repack", "-q", "-a", "-d");
    // Unpack, then drop the logo's blob to mimic a blob-filtered mirror.
    const logoBlob = git(bare, "rev-parse", `${second}:logo.png`);
    const packDir = join(bare, "objects/pack");
    for (const pack of (await readdir(packDir)).filter((f) => f.endsWith(".pack"))) {
      const data = await readFile(join(packDir, pack));
      await rm(join(packDir, pack));
      await rm(join(packDir, pack.replace(/\.pack$/, ".idx")));
      execFileSync("git", ["unpack-objects", "-q"], { cwd: bare, input: data, env: GIT_ENV });
    }
    await rm(join(bare, "objects", logoBlob.slice(0, 2), logoBlob.slice(2)));

    const checkout = await prepareHeadCheckout({ repoDir: bare, head: second });
    expect(checkout.kind).toBe("partial-worktree");
    expect(checkout.skippedFiles).toBe(1);
    expect(checkout.totalFiles).toBe(2);
    expect(await readFile(join(checkout.root, "a.ts"), "utf8")).toContain("version = 2");
    expect(existsSync(join(checkout.root, "logo.png"))).toBe(false);
    await checkout.cleanup();
  });

  it("fails with a clear error for an unknown head", async () => {
    await expect(
      prepareHeadCheckout({ repoDir: repo, head: "0000000000000000000000000000000000000000" }),
    ).rejects.toThrow(/cannot check out .*0000000/);
  });
});
