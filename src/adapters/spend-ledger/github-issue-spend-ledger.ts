/**
 * SpendLedgerPort over one GitHub issue in the consumer repo (SPEC NFR-10,
 * see ../../domain/spend-cap.ts). Why an issue and not a cache/artifact/
 * branch: the Action already has `issues: write` for labels and the
 * summary comment, an issue is visible to every human on the repo (they
 * can see the spend, edit the number to reset it, or close the issue to
 * start over — see docs/ACTION.md "Spend cap"), and it needs no extra
 * permission or storage backend.
 *
 * The issue is found by an HTML fingerprint marker in its body
 * (`<!-- jevest:spend-ledger -->`), the same idempotent-upsert pattern the
 * summary comment uses in ../vcs/github-vcs-adapter.ts. Open issues
 * labelled `jevest` are searched first (creating the label if missing);
 * if that finds nothing, every open issue is scanned, so a human who
 * removed the label does not silently fork a second ledger. The body is
 * a human-readable table followed by a fenced ```json block that is the
 * actual source of truth; `record` rewrites the whole body in place.
 *
 * Same narrowed-client pattern as `GitHubApiClient`: only the Octokit
 * methods used here, so a real `Octokit` satisfies it structurally and
 * tests pass a fake. Concurrency caveat is documented on the port.
 */
import type { SpendLedgerPort } from "../../domain/ports/spend-ledger-port.js";
import {
  type SpendCapConfig,
  type SpendEntry,
  type SpendLedger,
  applySpendEntry,
} from "../../domain/spend-cap.js";
import { decodeSpendLedger, encodeSpendLedger } from "./spend-ledger-codec.js";

interface GhResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Record<string, string | number | undefined>;
}

interface IssueData {
  readonly number: number;
  readonly body?: string | null;
}

/** The subset of the Octokit REST client this adapter depends on. */
export interface SpendLedgerGitHubClient {
  readonly issues: {
    listForRepo(params: {
      owner: string;
      repo: string;
      state: "open";
      labels?: string;
      per_page: number;
      page: number;
    }): Promise<GhResponse<IssueData[]>>;
    create(params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      labels: string[];
    }): Promise<GhResponse<IssueData>>;
    update(params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<GhResponse<IssueData>>;
    getLabel(params: { owner: string; repo: string; name: string }): Promise<
      GhResponse<{ name: string }>
    >;
    createLabel(params: {
      owner: string;
      repo: string;
      name: string;
    }): Promise<GhResponse<{ name: string }>>;
  };
}

export interface GitHubIssueSpendLedgerOptions {
  readonly client: SpendLedgerGitHubClient;
  readonly owner: string;
  readonly repo: string;
  /** Only used to render the cap column of the human-readable table. */
  readonly cap: SpendCapConfig;
}

export const LEDGER_MARKER = "<!-- jevest:spend-ledger -->";
export const LEDGER_LABEL = "jevest";
export const LEDGER_ISSUE_TITLE = "Jevest spend ledger";

const PER_PAGE = 100;
const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n```/;

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

export function renderLedgerIssueBody(ledger: SpendLedger, cap: SpendCapConfig): string {
  const json = JSON.stringify(encodeSpendLedger(ledger), null, 2);
  return [
    LEDGER_MARKER,
    "## Jevest spend ledger",
    "",
    "Maintained automatically by Jevest: cumulative LLM + Jev spend counted against",
    `\`spendCap\` in \`.jevest.yml\` (${cap.usd} USD per ${cap.period}, warning from ${cap.warnAtUsd} USD).`,
    "To reset the counter, edit `spent_usd` in the JSON block below or close this",
    'issue (a new one is created on the next run). See docs/ACTION.md "Spend cap".',
    "",
    "| Period | Spent (USD) | Runs | Last update | Cap (USD) |",
    "|---|---|---|---|---|",
    `| ${ledger.periodKey} | ${ledger.spentUsd.toFixed(4)} | ${ledger.runs} | ${ledger.updatedAt} | ${cap.usd} |`,
    "",
    "```json",
    json,
    "```",
  ].join("\n");
}

export function createGitHubIssueSpendLedger(
  options: GitHubIssueSpendLedgerOptions,
): SpendLedgerPort {
  const { client, owner, repo, cap } = options;

  async function listOpenIssues(labels: string | undefined): Promise<IssueData[]> {
    const all: IssueData[] = [];
    for (let page = 1; ; page++) {
      const { data } = await client.issues.listForRepo({
        owner,
        repo,
        state: "open",
        ...(labels !== undefined ? { labels } : {}),
        per_page: PER_PAGE,
        page,
      });
      all.push(...data);
      if (data.length < PER_PAGE) {
        return all;
      }
    }
  }

  /** 404 → create; a 422 on create means someone else created it first — fine either way. */
  async function ensureLabelExists(): Promise<void> {
    try {
      await client.issues.getLabel({ owner, repo, name: LEDGER_LABEL });
      return;
    } catch (error) {
      if (statusOf(error) !== 404) {
        throw error;
      }
    }
    try {
      await client.issues.createLabel({ owner, repo, name: LEDGER_LABEL });
    } catch (error) {
      if (statusOf(error) !== 422) {
        throw error;
      }
    }
  }

  async function findLedgerIssue(): Promise<IssueData | null> {
    await ensureLabelExists();
    const labelled = await listOpenIssues(LEDGER_LABEL);
    const byLabel = labelled.find((issue) => issue.body?.includes(LEDGER_MARKER));
    if (byLabel) {
      return byLabel;
    }
    const all = await listOpenIssues(undefined);
    return all.find((issue) => issue.body?.includes(LEDGER_MARKER)) ?? null;
  }

  function decodeIssue(issue: IssueData): SpendLedger {
    const match = issue.body?.match(JSON_BLOCK_RE);
    const source = `${owner}/${repo}#${issue.number}`;
    if (!match || match[1] === undefined) {
      throw new Error(`jevest: spend ledger at ${source} has no \`\`\`json block`);
    }
    return decodeSpendLedger(match[1], source);
  }

  return {
    async read(): Promise<SpendLedger | null> {
      const issue = await findLedgerIssue();
      return issue ? decodeIssue(issue) : null;
    },

    async record(entry: SpendEntry): Promise<SpendLedger> {
      const issue = await findLedgerIssue();
      const next = applySpendEntry(issue ? decodeIssue(issue) : null, entry);
      const body = renderLedgerIssueBody(next, cap);
      if (issue) {
        await client.issues.update({ owner, repo, issue_number: issue.number, body });
      } else {
        await client.issues.create({
          owner,
          repo,
          title: LEDGER_ISSUE_TITLE,
          body,
          labels: [LEDGER_LABEL],
        });
      }
      return next;
    },
  };
}
