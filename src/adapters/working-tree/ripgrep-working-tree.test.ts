import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RIPGREP_EXCLUDE_GLOBS,
  type RipgrepSpawn,
  createRipgrepWorkingTree,
  parseRipgrepJson,
} from "./ripgrep-working-tree.js";

function matchLine(path: string, line: number, words: string[]): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text: "irrelevant\n" },
      line_number: line,
      submatches: words.map((w) => ({ match: { text: w }, start: 0, end: w.length })),
    },
  });
}

describe("parseRipgrepJson", () => {
  it("turns match events into one match per distinct symbol, dropping ./", () => {
    const stdout = [
      JSON.stringify({ type: "begin", data: { path: { text: "./src/a.ts" } } }),
      matchLine("./src/a.ts", 3, ["computeTotal", "computeTotal", "applyTax"]),
      matchLine("./src/b.ts", 7, ["applyTax"]),
      JSON.stringify({ type: "summary", data: {} }),
      "",
    ].join("\n");
    expect(parseRipgrepJson(stdout, ["computeTotal", "applyTax"], 100)).toEqual([
      { symbol: "computeTotal", file: "src/a.ts", line: 3 },
      { symbol: "applyTax", file: "src/a.ts", line: 3 },
      { symbol: "applyTax", file: "src/b.ts", line: 7 },
    ]);
  });

  it("skips non-UTF-8 paths, unknown symbols, malformed lines, and caps per symbol", () => {
    const stdout = [
      JSON.stringify({
        type: "match",
        data: { path: { bytes: "AAA=" }, line_number: 1, submatches: [{ match: { text: "foo" } }] },
      }),
      matchLine("./x.ts", 1, ["notAsked"]),
      "{not json",
      matchLine("./x.ts", 2, ["computeTotal"]),
      matchLine("./x.ts", 3, ["computeTotal"]),
    ].join("\n");
    expect(parseRipgrepJson(stdout, ["computeTotal"], 1)).toEqual([
      { symbol: "computeTotal", file: "x.ts", line: 2 },
    ]);
  });
});

describe("createRipgrepWorkingTree — search arguments (fake spawn)", () => {
  it("runs a fixed-string, whole-word, path-sorted JSON search over the tree with the exclusions", async () => {
    const calls: { args: readonly string[]; cwd: string }[] = [];
    const spawn: RipgrepSpawn = async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      return { stdout: matchLine("./src/a.ts", 1, ["computeTotal"]), stderr: "", exitCode: 0 };
    };
    const tree = createRipgrepWorkingTree({ root: "/repo", spawn });
    const matches = await tree.searchSymbols(["computeTotal", "-dash"]);
    expect(matches).toEqual([{ symbol: "computeTotal", file: "src/a.ts", line: 1 }]);
    const [call] = calls;
    expect(call?.cwd).toBe("/repo");
    for (const flag of ["--json", "-n", "-w", "-F", "--sort", "path", "--no-config"]) {
      expect(call?.args).toContain(flag);
    }
    for (const glob of RIPGREP_EXCLUDE_GLOBS) {
      expect(call?.args).toContain(`!${glob}`);
    }
    // Every symbol goes through -e (safe for a leading dash), and the path is explicit (never stdin).
    const args = call?.args ?? [];
    expect(args[args.indexOf("-dash") - 1]).toBe("-e");
    expect(args.slice(-2)).toEqual(["--", "."]);
  });

  it("returns no matches on exit 1 and throws on exit 2 without output", async () => {
    const none = createRipgrepWorkingTree({
      root: "/repo",
      spawn: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
    });
    expect(await none.searchSymbols(["computeTotal"])).toEqual([]);
    const broken = createRipgrepWorkingTree({
      root: "/repo",
      spawn: async () => ({ stdout: "", stderr: "rg: bad", exitCode: 2 }),
    });
    await expect(broken.searchSymbols(["computeTotal"])).rejects.toThrow(/rg: bad/);
  });

  it("does not spawn for an empty symbol list", async () => {
    let spawned = false;
    const tree = createRipgrepWorkingTree({
      root: "/repo",
      spawn: async () => {
        spawned = true;
        return { stdout: "", stderr: "", exitCode: 1 };
      },
    });
    expect(await tree.searchSymbols([])).toEqual([]);
    expect(spawned).toBe(false);
  });
});

function hasRipgrep(): boolean {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasRipgrep())("createRipgrepWorkingTree — real rg on a temp tree", () => {
  let root = "";
  let outside = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jevest-rg-"));
    outside = await mkdtemp(join(tmpdir(), "jevest-rg-outside-"));
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(join(root, "node_modules/lib"), { recursive: true });
    await mkdir(join(root, "vendor/pkg"), { recursive: true });
    await mkdir(join(root, "public/build"), { recursive: true });
    await writeFile(
      join(root, "src/total.ts"),
      "export function computeTotal(n) {\n  return n;\n}\n",
    );
    await writeFile(
      join(root, "src/use.ts"),
      "const due = computeTotal(3);\nconst computeTotalish = 1;\n",
    );
    await writeFile(join(root, "tests/total.test.ts"), "expect(computeTotal(1)).toBe(1);\n");
    await writeFile(join(root, "node_modules/lib/index.js"), "computeTotal();\n");
    await writeFile(join(root, "vendor/pkg/x.php"), "computeTotal();\n");
    await writeFile(join(root, "public/build/app.js"), "computeTotal();\n");
    await writeFile(join(root, "src/app.min.js"), "computeTotal();\n");
    await writeFile(join(root, "package-lock.json"), '{"computeTotal": 1}\n');
    await writeFile(join(outside, "secret.txt"), "outside the tree\n");
    await symlink(join(outside, "secret.txt"), join(root, "src/link.txt"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("finds whole-word references and skips vendored, built, minified and lock files", async () => {
    const tree = createRipgrepWorkingTree({ root });
    const matches = await tree.searchSymbols(["computeTotal"]);
    expect(matches).toEqual([
      { symbol: "computeTotal", file: "src/total.ts", line: 1 },
      { symbol: "computeTotal", file: "src/use.ts", line: 1 },
      { symbol: "computeTotal", file: "tests/total.test.ts", line: 1 },
    ]);
  });

  it("reads files inside the tree, never outside it", async () => {
    const tree = createRipgrepWorkingTree({ root });
    expect(await tree.readFile("src/use.ts")).toContain("computeTotal(3)");
    expect(await tree.readFile("./src/use.ts")).toContain("computeTotal(3)");
    expect(await tree.readFile("src/missing.ts")).toBeNull();
    expect(await tree.readFile("src")).toBeNull();
    expect(await tree.readFile("../x")).toBeNull();
    expect(await tree.readFile(join(outside, "secret.txt"))).toBeNull();
    expect(await tree.readFile("src/link.txt")).toBeNull();
  });
});
