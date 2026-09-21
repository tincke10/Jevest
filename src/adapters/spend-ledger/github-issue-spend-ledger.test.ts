import { describe, expect, it, vi } from "vitest";
import {
  LEDGER_ISSUE_TITLE,
  LEDGER_LABEL,
  LEDGER_MARKER,
  type SpendLedgerGitHubClient,
  createGitHubIssueSpendLedger,
  renderLedgerIssueBody,
} from "./github-issue-spend-ledger.js";

const REPO = { owner: "acme", repo: "widgets" };
const CAP = { usd: 50, period: "month" as const, warnAtUsd: 40 };

function ghResponse<T>(data: T) {
  return { data, status: 200, headers: {} };
}

function githubError(status: number): Error & { status: number } {
  const error = new Error(`GitHub API error ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

const STORED = {
  periodKey: "2026-09",
  spentUsd: 12.5,
  runs: 3,
  updatedAt: "2026-09-20T10:00:00.000Z",
};

function createFakeClient(
  overrides: Partial<SpendLedgerGitHubClient["issues"]> = {},
): SpendLedgerGitHubClient {
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue(ghResponse([])),
      create: vi.fn().mockResolvedValue(ghResponse({ number: 99 })),
      update: vi.fn().mockResolvedValue(ghResponse({ number: 99 })),
      getLabel: vi.fn().mockResolvedValue(ghResponse({ name: LEDGER_LABEL })),
      createLabel: vi.fn().mockResolvedValue(ghResponse({ name: LEDGER_LABEL })),
      ...overrides,
    },
  };
}

const entry = {
  periodKey: "2026-09",
  prNumber: 7,
  headSha: "abc123",
  llmUsd: 1.5,
  jevUsd: 0.001,
  at: "2026-09-21T16:00:00.000Z",
};

describe("renderLedgerIssueBody", () => {
  it("carries the fingerprint marker, a human table and a fenced json block", () => {
    const body = renderLedgerIssueBody(STORED, CAP);
    expect(body).toContain(LEDGER_MARKER);
    expect(body).toContain("| 2026-09 | 12.5000 | 3 | 2026-09-20T10:00:00.000Z | 50 |");
    expect(body).toContain("```json\n");
    expect(body).toContain('"period_key": "2026-09"');
    expect(body).toContain('"spent_usd": 12.5');
  });
});

describe("createGitHubIssueSpendLedger", () => {
  describe("read", () => {
    it("returns null when no ledger issue exists", async () => {
      const client = createFakeClient();
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });
      expect(await ledger.read()).toBeNull();
      expect(client.issues.listForRepo).toHaveBeenCalledWith(
        expect.objectContaining({ ...REPO, state: "open", labels: LEDGER_LABEL }),
      );
    });

    it("finds the issue by the marker among labelled open issues and decodes the json block", async () => {
      const client = createFakeClient({
        listForRepo: vi.fn().mockResolvedValue(
          ghResponse([
            { number: 3, body: "unrelated jevest issue" },
            { number: 5, body: renderLedgerIssueBody(STORED, CAP) },
          ]),
        ),
      });
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });
      expect(await ledger.read()).toEqual(STORED);
    });

    it("falls back to scanning all open issues when the labelled search finds nothing", async () => {
      const listForRepo = vi
        .fn()
        .mockResolvedValueOnce(ghResponse([]))
        .mockResolvedValueOnce(
          ghResponse([{ number: 8, body: renderLedgerIssueBody(STORED, CAP) }]),
        );
      const client = createFakeClient({ listForRepo });
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });
      expect(await ledger.read()).toEqual(STORED);
      expect(listForRepo).toHaveBeenCalledTimes(2);
      expect(listForRepo.mock.calls[1]?.[0]).not.toHaveProperty("labels");
    });

    it("creates the jevest label when it is missing and ignores a 422 on creation", async () => {
      const client = createFakeClient({
        getLabel: vi.fn().mockRejectedValue(githubError(404)),
        createLabel: vi.fn().mockRejectedValue(githubError(422)),
      });
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });
      expect(await ledger.read()).toBeNull();
      expect(client.issues.createLabel).toHaveBeenCalledWith(
        expect.objectContaining({ ...REPO, name: LEDGER_LABEL }),
      );
    });

    it("throws when the ledger issue body has a malformed json block", async () => {
      const client = createFakeClient({
        listForRepo: vi
          .fn()
          .mockResolvedValue(
            ghResponse([{ number: 5, body: `${LEDGER_MARKER}\n\n\`\`\`json\n{oops\n\`\`\`` }]),
          ),
      });
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });
      await expect(ledger.read()).rejects.toThrow(/spend ledger/);
    });
  });

  describe("record", () => {
    it("creates the ledger issue on first use with title, label and rendered body", async () => {
      const client = createFakeClient();
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });

      const after = await ledger.record(entry);

      expect(after).toEqual({
        periodKey: "2026-09",
        spentUsd: 1.501,
        runs: 1,
        updatedAt: entry.at,
      });
      expect(client.issues.create).toHaveBeenCalledWith({
        ...REPO,
        title: LEDGER_ISSUE_TITLE,
        labels: [LEDGER_LABEL],
        body: renderLedgerIssueBody(after, CAP),
      });
      expect(client.issues.update).not.toHaveBeenCalled();
    });

    it("rewrites the existing issue body (upsert) adding to the stored total", async () => {
      const client = createFakeClient({
        listForRepo: vi
          .fn()
          .mockResolvedValue(ghResponse([{ number: 5, body: renderLedgerIssueBody(STORED, CAP) }])),
      });
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });

      const after = await ledger.record(entry);

      expect(after).toEqual({
        periodKey: "2026-09",
        spentUsd: 14.001,
        runs: 4,
        updatedAt: entry.at,
      });
      expect(client.issues.update).toHaveBeenCalledWith({
        ...REPO,
        issue_number: 5,
        body: renderLedgerIssueBody(after, CAP),
      });
      expect(client.issues.create).not.toHaveBeenCalled();
    });

    it("starts a fresh total in the same issue when the period rolled over", async () => {
      const client = createFakeClient({
        listForRepo: vi
          .fn()
          .mockResolvedValue(
            ghResponse([
              { number: 5, body: renderLedgerIssueBody({ ...STORED, periodKey: "2026-08" }, CAP) },
            ]),
          ),
      });
      const ledger = createGitHubIssueSpendLedger({ client, ...REPO, cap: CAP });
      const after = await ledger.record(entry);
      expect(after).toEqual({
        periodKey: "2026-09",
        spentUsd: 1.501,
        runs: 1,
        updatedAt: entry.at,
      });
    });
  });
});
