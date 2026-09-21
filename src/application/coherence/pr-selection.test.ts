import { describe, expect, it } from "vitest";
import type { PrFile, PrRecord } from "./pr-record.js";
import {
  countBasenameLeaks,
  describeDistribution,
  generateCoherencePairs,
  isEligiblePr,
  stripPrTemplate,
} from "./pr-selection.js";

const LONG = "This change normalizes the path before lookup so trailing slashes match. ".repeat(4);

function file(path: string, overrides: Partial<PrFile> = {}): PrFile {
  return { path, status: "modified", additions: 5, deletions: 2, ...overrides };
}

function candidate(overrides: Partial<Parameters<typeof isEligiblePr>[0]> = {}) {
  return {
    merged: true,
    author: "someone",
    title: "fix(router): trailing slash",
    body: LONG,
    files: [file("src/router.ts"), file("src/router.test.ts")],
    ...overrides,
  };
}

function record(repo: string, number: number, overrides: Partial<PrRecord> = {}): PrRecord {
  return {
    id: `${repo}#${number}`,
    repo,
    number,
    title: `PR ${number}`,
    body: `Body of ${number}`,
    labels: [],
    author: "someone",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    mergedAt: "2026-01-02T03:04:05Z",
    files: [file("src/thing.ts")],
    datasetVersion: 1,
    ...overrides,
  };
}

describe("stripPrTemplate", () => {
  it("removes single-line and multi-line HTML comments", () => {
    const body = "Intro <!-- one line -->\n<!--\nmulti\nline\n-->\nOutro";
    expect(stripPrTemplate(body)).toBe("Intro\nOutro");
  });

  it("removes markdown checklist lines but keeps plain bullets", () => {
    const body = "- [ ] todo\n- [x] done\n* [X] also done\n- keep me\nText";
    expect(stripPrTemplate(body)).toBe("- keep me\nText");
  });

  it("drops headings whose section is empty and keeps headings with content", () => {
    const body = "## Description\n\nReal text here.\n\n## Checklist\n\n- [ ] a\n\n### Notes\n\n";
    expect(stripPrTemplate(body)).toBe("## Description\n\nReal text here.");
  });

  it("collapses 3+ blank lines into one blank line and trims trailing whitespace", () => {
    const body = "a  \n\n\n\n\nb\t\n\n\n";
    expect(stripPrTemplate(body)).toBe("a\n\nb");
  });
});

describe("isEligiblePr", () => {
  it("accepts a merged, human, well-described, small PR with a source file", () => {
    expect(isEligiblePr(candidate())).toEqual({ eligible: true });
  });

  it("rejects an unmerged PR", () => {
    expect(isEligiblePr(candidate({ merged: false }))).toEqual({
      eligible: false,
      reason: "not-merged",
    });
  });

  it.each(["dependabot[bot]", "renovate", "github-actions", "dependabot", "renovate[bot]"])(
    "rejects bot author %s",
    (author) => {
      expect(isEligiblePr(candidate({ author }))).toEqual({
        eligible: false,
        reason: "bot-author",
      });
    },
  );

  it("measures body length AFTER stripping template boilerplate", () => {
    const filler = `<!--${"x".repeat(300)}-->\n${"- [ ] item\n".repeat(30)}short`;
    expect(isEligiblePr(candidate({ body: filler }))).toEqual({
      eligible: false,
      reason: "short-body",
    });
  });

  it("only runs the cheap checks when files are not provided yet", () => {
    const { files: _omit, ...withoutFiles } = candidate();
    expect(isEligiblePr(withoutFiles)).toEqual({ eligible: true });
    expect(isEligiblePr({ ...withoutFiles, merged: false })).toEqual({
      eligible: false,
      reason: "not-merged",
    });
  });

  it("rejects 0 files and more than 12 files", () => {
    expect(isEligiblePr(candidate({ files: [] }))).toEqual({
      eligible: false,
      reason: "file-count",
    });
    const many = Array.from({ length: 13 }, (_, i) => file(`src/f${i}.ts`));
    expect(isEligiblePr(candidate({ files: many }))).toEqual({
      eligible: false,
      reason: "file-count",
    });
  });

  it("rejects more than 500 changed lines in total", () => {
    const files = [
      file("src/a.ts", { additions: 300, deletions: 100 }),
      file("src/b.ts", { additions: 101, deletions: 0 }),
    ];
    expect(isEligiblePr(candidate({ files }))).toEqual({
      eligible: false,
      reason: "too-many-changed-lines",
    });
    const okFiles = [
      file("src/a.ts", { additions: 300, deletions: 100 }),
      file("src/b.ts", { additions: 100, deletions: 0 }),
    ];
    expect(isEligiblePr(candidate({ files: okFiles }))).toEqual({ eligible: true });
  });

  it("rejects PRs whose files are all docs, lockfiles or changesets", () => {
    const files = [
      file("README.md"),
      file("docs/guide.mdx"),
      file("website/docs/api.ts"),
      file("pnpm-lock.yaml"),
      file("package-lock.json"),
      file("yarn.lock"),
      file("bun.lockb"),
      file(".changeset/happy-cats.md"),
    ];
    expect(isEligiblePr(candidate({ files }))).toEqual({
      eligible: false,
      reason: "no-source-file",
    });
    expect(isEligiblePr(candidate({ files: [...files, file("src/index.ts")] }))).toEqual({
      eligible: true,
    });
  });

  it("rejects a secret anywhere in title, body or patches", () => {
    const token = `ghp_${"A".repeat(30)}`;
    expect(isEligiblePr(candidate({ title: `add ${token}` }))).toEqual({
      eligible: false,
      reason: "secret",
    });
    expect(isEligiblePr(candidate({ body: `${LONG}\napi_key = "hunter2hunter2"` }))).toEqual({
      eligible: false,
      reason: "secret",
    });
    const files = [file("src/a.ts", { patch: `+const x = "${token}";` })];
    expect(isEligiblePr(candidate({ files }))).toEqual({ eligible: false, reason: "secret" });
  });
});

describe("generateCoherencePairs", () => {
  const records = [
    ...Array.from({ length: 5 }, (_, i) => record("a/a", i + 1)),
    ...Array.from({ length: 3 }, (_, i) => record("b/b", i + 100)),
  ];

  it("emits two pairs per record: one coherent and one incoherent", () => {
    const pairs = generateCoherencePairs(records, 42);
    expect(pairs).toHaveLength(2 * records.length);
    const coherent = pairs.filter((p) => p.label === "coherent");
    expect(coherent).toHaveLength(records.length);
    for (const p of coherent) expect(p.descriptionPrId).toBe(p.prId);
    expect(new Set(coherent.map((p) => p.prId)).size).toBe(records.length);
  });

  it("has no fixed points and uses each description once per repo, within the same repo", () => {
    const pairs = generateCoherencePairs(records, 42);
    const incoherent = pairs.filter((p) => p.label === "incoherent");
    expect(incoherent).toHaveLength(records.length);
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const p of incoherent) {
      expect(p.descriptionPrId).not.toBe(p.prId);
      expect(byId.get(p.descriptionPrId)?.repo).toBe(byId.get(p.prId)?.repo);
    }
    expect(new Set(incoherent.map((p) => p.prId)).size).toBe(records.length);
    expect(new Set(incoherent.map((p) => p.descriptionPrId)).size).toBe(records.length);
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const first = generateCoherencePairs(records, 7);
    expect(generateCoherencePairs(records, 7)).toEqual(first);
    const seeds = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11];
    const distinct = new Set(seeds.map((s) => JSON.stringify(generateCoherencePairs(records, s))));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("never produces a fixed point across many seeds", () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const p of generateCoherencePairs(records, seed)) {
        if (p.label === "incoherent") expect(p.descriptionPrId).not.toBe(p.prId);
      }
    }
  });

  it("works for a repo with exactly two PRs", () => {
    const two = [record("c/c", 1), record("c/c", 2)];
    const incoherent = generateCoherencePairs(two, 1).filter((p) => p.label === "incoherent");
    expect(incoherent.map((p) => [p.prId, p.descriptionPrId]).sort()).toEqual([
      ["c/c#1", "c/c#2"],
      ["c/c#2", "c/c#1"],
    ]);
  });

  it("throws when a repo has fewer than two PRs", () => {
    expect(() => generateCoherencePairs([...records, record("lonely/repo", 1)], 42)).toThrow(
      /lonely\/repo/,
    );
  });
});

describe("countBasenameLeaks", () => {
  it("counts incoherent pairs whose foreign description mentions a basename of the change", () => {
    const records = [
      record("a/a", 1, { files: [file("src/router.ts")], body: "touches nothing named" }),
      record("a/a", 2, { files: [file("src/context.ts")], body: "see router.ts for details" }),
      record("a/a", 3, { files: [file("packages/x/src/index.ts")], title: "fix context.ts" }),
    ];
    const pairs = [
      { prId: "a/a#1", descriptionPrId: "a/a#1", label: "coherent" as const },
      { prId: "a/a#1", descriptionPrId: "a/a#2", label: "incoherent" as const }, // router.ts leaks
      { prId: "a/a#2", descriptionPrId: "a/a#3", label: "incoherent" as const }, // context.ts leaks (title)
      { prId: "a/a#3", descriptionPrId: "a/a#1", label: "incoherent" as const }, // clean
    ];
    expect(countBasenameLeaks(records, pairs)).toBe(2);
  });
});

describe("describeDistribution", () => {
  it("reports min, percentiles and max using nearest-rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(describeDistribution(values)).toEqual({
      n: 100,
      min: 1,
      p25: 25,
      p50: 50,
      p75: 75,
      p90: 90,
      max: 100,
    });
  });

  it("returns zeros for an empty input", () => {
    expect(describeDistribution([])).toEqual({
      n: 0,
      min: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      max: 0,
    });
  });
});
