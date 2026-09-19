import { describe, expect, it } from "vitest";
import { createFakeDecisionAdapter } from "../../../adapters/fake-decision-adapter.js";
import type { ConfidencePolicyConfig } from "../../../domain/confidence-policy.js";
import type { Decision } from "../../../domain/decision.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import { runHunkProfileStage } from "./hunk-profile.js";

const policyConfig: ConfidencePolicyConfig = {
  hunk_profile: {
    low: { autoMin: 0.85, confirmMin: 0.55 },
    medium: { autoMin: 0.9, confirmMin: 0.6 },
  },
};

function makePr(files: PullRequestData["files"]): PullRequestData {
  return {
    ref: { owner: "acme", repo: "widgets", number: 1, headSha: "head", baseSha: "base" },
    title: "t",
    body: "b",
    author: "dev",
    labels: [],
    baseBranch: "main",
    files,
    ciStatus: "success",
  };
}

function scriptFor(
  changeKind: string,
  changeKindConfidence: number,
  errHandling: number,
  async: number,
): Record<string, Decision> {
  return {
    change_kind: {
      type: "choice",
      choice: changeKind,
      confidence: changeKindConfidence,
      probabilities: {
        "add-behavior": changeKind === "add-behavior" ? 0.7 : 0.1,
        "modify-behavior": changeKind === "modify-behavior" ? 0.7 : 0.1,
        delete: changeKind === "delete" ? 0.7 : 0.1,
        "rename-or-format": changeKind === "rename-or-format" ? 0.7 : 0.1,
      },
    },
    touches_error_handling: { type: "noul", noul: errHandling },
    touches_async: { type: "noul", noul: async },
  };
}

describe("runHunkProfileStage", () => {
  it("profiles each hunk with change_kind, touches_error_handling, touches_async from Jev", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("modify-behavior", 0.9, 0.1, 0.2));

    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: ["rename-or-format"],
      maxHunks: 50,
    });

    expect(result.hunks).toHaveLength(1);
    const [hunk] = result.hunks;
    expect(hunk!.changeKind).toBe("modify-behavior");
    expect(hunk!.changeKindConfidence).toBe(0.9);
    expect(hunk!.touchesErrorHandlingProb).toBe(0.1);
    expect(hunk!.touchesAsyncProb).toBe(0.2);
    expect(hunk!.requestId).toMatch(/^fake_/);
    expect(hunk!.before).toBe("old");
    expect(result.totalRequests).toBe(1);
  });

  it("issues one Jev request per hunk, never batching multiple hunks (NFR-14)", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 2,
        deletions: 2,
        patch: "@@ -1,1 +1,1 @@\n-x\n+y\n@@ -10,1 +10,1 @@\n-p\n+q",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("add-behavior", 0.9, 0.1, 0.1));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 50,
    });
    expect(result.hunks).toHaveLength(2);
    expect(result.totalRequests).toBe(2);
  });

  it("skips a hunk from review when change_kind is in skipChangeKinds and confidence is auto band (FR-3.3)", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,1 @@\n-x\n+x",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("rename-or-format", 0.9, 0.05, 0.05));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: ["rename-or-format"],
      maxHunks: 50,
    });
    expect(result.hunks[0]!.skippedFromReview).toBe(true);
  });

  it("does not skip a rename-or-format hunk when confidence is below the auto band", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,1 @@\n-x\n+x",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("rename-or-format", 0.6, 0.05, 0.05));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: ["rename-or-format"],
      maxHunks: 50,
    });
    expect(result.hunks[0]!.skippedFromReview).toBe(false);
  });

  it("does not skip a change_kind not in skipChangeKinds even at high confidence", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,1 @@\n-x\n+x",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("add-behavior", 0.99, 0.05, 0.05));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: ["rename-or-format"],
      maxHunks: 50,
    });
    expect(result.hunks[0]!.skippedFromReview).toBe(false);
  });

  it("flags a hunk containing a secret, and never sends it to Jev (NFR-3)", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,1 @@\n-x\n+const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";',
      },
    ];
    const port = createFakeDecisionAdapter({});
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 50,
    });
    expect(result.hunks[0]!.containsSecret).toBe(true);
    expect(result.hunks[0]!.requestId).toBeNull();
    expect(result.hunks[0]!.skippedFromReview).toBe(true);
    expect(result.totalRequests).toBe(0);
  });

  it("computes touchesPublicApi from the hunk fragment and flags it partial when no file fetcher is given", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch:
          "@@ -1,1 +1,1 @@\n-export function greet(name: string): string { return name; }\n+export function greet(name: string, loud: boolean): string { return name; }",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("modify-behavior", 0.9, 0.1, 0.1));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 50,
    });
    expect(result.hunks[0]!.touchesPublicApi).toBe(true);
    expect(result.hunks[0]!.touchesPublicApiPartial).toBe(true);
  });

  it("computes touchesPublicApi from the full file and marks it non-partial when a file fetcher is given", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -2,1 +2,1 @@\n-  return x + 1;\n+  return x + 2;",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("modify-behavior", 0.9, 0.1, 0.1));
    const fetchFileContent = async (_path: string, sha: string) =>
      sha === "base"
        ? "export function compute(x: number) {\n  return x + 1;\n}"
        : "export function compute(x: number, extra: number) {\n  return x + 2;\n}";

    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 50,
      fetchFileContent,
    });
    // Full file shows the exported signature changed (extra param) — only visible with full-file context.
    expect(result.hunks[0]!.touchesPublicApi).toBe(true);
    expect(result.hunks[0]!.touchesPublicApiPartial).toBe(false);
  });

  it("truncates beyond maxHunks and reports how many were skipped", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 2,
        deletions: 2,
        patch: "@@ -1,1 +1,1 @@\n-x\n+y\n@@ -10,1 +10,1 @@\n-p\n+q",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("add-behavior", 0.9, 0.1, 0.1));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 1,
    });
    expect(result.hunks).toHaveLength(1);
    expect(result.truncatedHunkCount).toBe(1);
  });

  it("continues past a per-hunk Jev failure, still sending the hunk to review without a profile (NFR-2 fail-closed)", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,1 +1,1 @@\n-x\n+y",
      },
      {
        path: "b.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,1 +1,1 @@\n-p\n+q",
      },
    ];
    const fakePort = createFakeDecisionAdapter(scriptFor("add-behavior", 0.9, 0.1, 0.1));
    // "a.ts"'s request throws; "b.ts"'s request is answered normally.
    const port = {
      decide: async (state: string, questions: never) => {
        if (typeof state === "string" && state.includes("-x")) {
          throw new Error("jev timeout");
        }
        return fakePort.decide(state, questions);
      },
    };
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 50,
    });

    expect(result.hunks).toHaveLength(2);
    const failed = result.hunks.find((h) => h.file === "a.ts")!;
    expect(failed.profileFailed).toBe(true);
    expect(failed.skippedFromReview).toBe(false);
    expect(failed.containsSecret).toBe(false);
    expect(failed.changeKind).toBeNull();
    expect(failed.requestId).toBeNull();

    const ok = result.hunks.find((h) => h.file === "b.ts")!;
    expect(ok.profileFailed).toBe(false);
    expect(ok.changeKind).toBe("add-behavior");
  });

  it("accumulates total usage across hunks", async () => {
    const files: PullRequestData["files"] = [
      {
        path: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1,1 +1,1 @@\n-x\n+y",
      },
    ];
    const port = createFakeDecisionAdapter(scriptFor("add-behavior", 0.9, 0.1, 0.1));
    const result = await runHunkProfileStage({
      pr: makePr(files),
      decisionPort: port,
      policyConfig,
      riskLevel: "low",
      skipChangeKinds: [],
      maxHunks: 50,
    });
    expect(result.totalUsage.inputTokens).toBe(0); // FakeDecisionAdapter always returns 0 usage
  });
});
