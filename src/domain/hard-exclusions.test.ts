import { describe, expect, it } from "vitest";
import type { AgenticFinding } from "./agentic-finding.js";
import { exclusionFor, isExcludedFile } from "./hard-exclusions.js";

const changed = ["src/a.ts", "src/b.ts", "README.md", "package-lock.json"];

function finding(overrides: Partial<AgenticFinding> = {}): AgenticFinding {
  return {
    file: "src/a.ts",
    line: 10,
    category: "correctness",
    severity: "high",
    claim: "The loop skips the last element.",
    failingScenario: "items=[1,2,3] -> only 1 and 2 are summed.",
    evidence: [{ file: "src/a.ts", line: 10, quote: "for (let i = 0; i < n - 1; i++)" }],
    confidence: 0.8,
    ...overrides,
  };
}

describe("exclusionFor", () => {
  it("keeps a finding in an allowed category with evidence in a changed file", () => {
    expect(exclusionFor(finding(), changed)).toBeNull();
  });

  it("drops a category outside the allowlist", () => {
    const result = exclusionFor(
      finding({ category: "style" as unknown as AgenticFinding["category"] }),
      changed,
    );
    expect(result?.reason).toBe("category");
  });

  it("drops a finding none of whose evidence is in a file the PR changed", () => {
    const result = exclusionFor(
      finding({ evidence: [{ file: "src/other.ts", line: 3, quote: "callers()" }] }),
      changed,
    );
    expect(result?.reason).toBe("no-evidence-in-changed-file");
  });

  it("keeps a cross-file finding that cites the changed code causing it", () => {
    const result = exclusionFor(
      finding({
        file: "src/consumer.ts",
        evidence: [
          { file: "src/consumer.ts", line: 4, quote: "useIt(x.total)" },
          { file: "./src/b.ts", line: 9, quote: "delete x.total" },
        ],
      }),
      changed,
    );
    expect(result).toBeNull();
  });

  it("matches evidence paths with diff prefixes (a/, b/) or a leading ./", () => {
    expect(
      exclusionFor(
        finding({ evidence: [{ file: "b/src/a.ts", line: 1, quote: "xxxx" }] }),
        changed,
      ),
    ).toBeNull();
  });

  it.each([
    ["package-lock.json"],
    ["pnpm-lock.yaml"],
    ["vendor/composer.lock"],
    ["public/app.min.js"],
    ["dist/bundle.js"],
    ["README.md"],
    ["docs/guide.mdx"],
    ["src/api.generated.ts"],
  ])("drops a finding located in a generated, lock, minified or markdown file: %s", (file) => {
    const result = exclusionFor(
      finding({ file, evidence: [{ file: "src/a.ts", line: 1, quote: "xxxx" }] }),
      changed,
    );
    expect(result?.reason).toBe("excluded-file");
  });

  it.each([
    ["An attacker could send many requests and cause a denial of service."],
    ["There is no rate limiting on this endpoint."],
    ["Consider adding logging when the retry fails."],
    ["The variable name `x` should follow the naming convention."],
    ["Formatting of this block is inconsistent."],
    ["Missing documentation for the exported function."],
  ])("drops a claim about DoS, rate limits, logging or style: %s", (claim) => {
    const result = exclusionFor(finding({ claim }), changed);
    expect(result?.reason).toBe("excluded-claim");
  });

  it("does not drop a real correctness claim that merely mentions a log", () => {
    expect(
      exclusionFor(
        finding({ claim: "The error branch logs and then returns undefined instead of throwing." }),
        changed,
      ),
    ).toBeNull();
  });

  it("checks the rules in order: category, file, claim, evidence", () => {
    const result = exclusionFor(
      finding({
        category: "docs" as unknown as AgenticFinding["category"],
        file: "README.md",
        evidence: [],
      }),
      changed,
    );
    expect(result?.reason).toBe("category");
  });

  it("gives a human-readable detail with every drop", () => {
    const result = exclusionFor(finding({ file: "yarn.lock" }), changed);
    expect(result?.detail).toMatch(/yarn\.lock/);
  });
});

describe("isExcludedFile", () => {
  it("keeps ordinary source and test files", () => {
    expect(isExcludedFile("src/app/service.ts")).toBe(false);
    expect(isExcludedFile("tests/service.test.ts")).toBe(false);
    expect(isExcludedFile("app/Http/Controller.php")).toBe(false);
  });
});
