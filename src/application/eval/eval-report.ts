/**
 * Markdown for one eval run, a side-by-side comparison of several, and the
 * label queue (unlabeled candidates in the golden issue shape, to be
 * adjudicated and appended to the set). See docs/EVAL.md.
 */
import type { EvalResults } from "./eval-run.js";
import { GOLDEN_SEVERITIES, type GoldenSeverity } from "./golden-set.js";
import type { EvalView, FoundOfTotal, ViewMetrics } from "./metrics.js";

const MAX_TEXT = 200;

function cell(text: string): string {
  const flat = text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function totalCost(totals: EvalResults["totals"]): string {
  if (totals.casesWithCost === 0) return "—";
  return totals.costKnownForAllCases ? usd(totals.costUsd) : `${usd(totals.costUsd)} (partial)`;
}

function frac(entry: FoundOfTotal): string {
  return `${entry.found}/${entry.total}`;
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
}

function viewRows(view: ViewMetrics, label: string): string[] {
  return [
    `| recall ${label} (real+partly) | ${view.targetsFound}/${view.targets} (${pct(view.recall)}) |`,
    `| weighted recall ${label} | ${view.weightedFound.toFixed(1)}/${view.weightedTotal.toFixed(1)} (${pct(view.weightedRecall)}) |`,
  ];
}

export function renderEvalReport(results: EvalResults): string {
  const { totals } = results;
  const lines: string[] = [
    `# Eval: ${results.variant}`,
    "",
    `Set: \`${results.setPath}\` · ${totals.cases} case(s) · ${results.createdAt}`,
    `Source: \`${JSON.stringify(results.source)}\``,
    `Matcher: \`${JSON.stringify(results.matcher)}\``,
    "",
    "## Headline",
    "",
    "| metric | value |",
    "| --- | --- |",
  ];
  for (const severity of GOLDEN_SEVERITIES) {
    lines.push(`| real ${severity} | ${frac(totals.shown.realBySeverity[severity])} |`);
  }
  lines.push(
    ...viewRows(totals.shown, "shown"),
    ...viewRows(totals.all, "shown+low"),
    `| known-false shown | ${totals.shown.knownFalse} |`,
    `| unverifiable shown | ${totals.shown.unverifiable} |`,
    `| unlabeled shown | ${totals.shown.unlabeled} |`,
    `| shown candidates | ${totals.shown.candidates} |`,
    `| shown precision (lower bound) | ${pct(totals.shown.precisionLowerBound)} |`,
    `| cost | ${totalCost(totals)} |`,
    `| tokens | ${totals.tokens} |`,
    `| wall time | ${minutes(totals.wallTimeMs)} |`,
    "",
    "Real issues are counted when found in the shown bucket; `shown+low` adds what the review kept out of sight.",
    "",
    "## Per case",
    "",
    "| case | real+partly shown | shown+low | weighted shown | known-false shown | unlabeled shown | shown | cost | error |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const c of results.cases) {
    const m = c.metrics;
    lines.push(
      `| ${c.caseId} | ${m.shown.targetsFound}/${m.shown.targets} | ${m.all.targetsFound}/${m.all.targets} | ${pct(m.shown.weightedRecall)} | ${m.shown.knownFalse} | ${m.shown.unlabeled} | ${m.shown.candidates} | ${m.costUsd === null ? "—" : usd(m.costUsd)} | ${c.error === null ? "" : cell(c.error)} |`,
    );
  }

  const listed = (title: string, pick: (c: EvalResults["cases"][number]) => string[]) => {
    const rows = results.cases.flatMap(pick);
    lines.push("", `## ${title}`, "");
    if (rows.length === 0) lines.push("None.");
    else lines.push(...rows);
  };
  listed("Unlabeled shown (label these to grow the set)", (c) =>
    c.candidates
      .filter((m) => m.bucket === "shown" && m.issueId === null)
      .map(
        (m) =>
          `- ${c.caseId} · ${m.source} · \`${m.file ?? "?"}:${m.line ?? "?"}\` — ${cell(m.text)}`,
      ),
  );
  listed("Known-false shown", (c) =>
    c.candidates
      .filter((m) => m.bucket === "shown" && m.issueId !== null)
      .filter((m) => c.falseIssueIds.includes(m.issueId as string))
      .map(
        (m) =>
          `- ${c.caseId} · ${m.issueId} · \`${m.file ?? "?"}:${m.line ?? "?"}\` — ${cell(m.text)}`,
      ),
  );
  return `${lines.join("\n")}\n`;
}

export function renderComparison(runs: readonly EvalResults[]): string {
  const header = `| metric | ${runs.map((r) => r.variant).join(" | ")} |`;
  const divider = `| --- | ${runs.map(() => "---").join(" | ")} |`;
  const row = (label: string, pick: (r: EvalResults) => string) =>
    `| ${label} | ${runs.map(pick).join(" | ")} |`;
  const lines = [header, divider];
  for (const severity of GOLDEN_SEVERITIES) {
    lines.push(
      row(`real found (${severity})`, (r) => frac(r.totals.shown.realBySeverity[severity])),
    );
  }
  lines.push(
    row(
      "recall shown",
      (r) =>
        `${r.totals.shown.targetsFound}/${r.totals.shown.targets} (${pct(r.totals.shown.recall)})`,
    ),
    row("weighted recall shown", (r) => pct(r.totals.shown.weightedRecall)),
    row(
      "recall shown+low",
      (r) => `${r.totals.all.targetsFound}/${r.totals.all.targets} (${pct(r.totals.all.recall)})`,
    ),
    row("known noise shown", (r) => String(r.totals.shown.knownFalse)),
    row("unlabeled shown", (r) => String(r.totals.shown.unlabeled)),
    row("shown candidates", (r) => String(r.totals.shown.candidates)),
    row("shown precision (lower bound)", (r) => pct(r.totals.shown.precisionLowerBound)),
    row("cost USD", (r) => totalCost(r.totals)),
    row("tokens", (r) => String(r.totals.tokens)),
    row("wall time", (r) => minutes(r.totals.wallTimeMs)),
    row("cases", (r) => String(r.totals.cases)),
  );
  return `${lines.join("\n")}\n`;
}

export interface LabelQueueItem {
  readonly caseId: string;
  readonly id: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly title: string;
  readonly severity: GoldenSeverity;
  readonly verdict: "unlabeled";
  readonly notes: string;
}

const SEVERITY_ALIASES: Readonly<Record<string, GoldenSeverity>> = {
  critical: "critical",
  blocker: "critical",
  high: "high",
  major: "high",
  medium: "medium",
  moderate: "medium",
  low: "low",
  minor: "low",
  nit: "low",
  info: "low",
};

/** Unlabeled candidates of `view` as golden issues with `verdict: "unlabeled"` (docs/EVAL.md "Growing the set"). */
export function buildLabelQueue(results: EvalResults, view: EvalView): LabelQueueItem[] {
  return results.cases.flatMap((c) =>
    c.candidates
      .filter((m) => m.issueId === null && (view === "all" || m.bucket === "shown"))
      .map((m) => {
        const reported = m.severity?.toLowerCase();
        const severity = (reported && SEVERITY_ALIASES[reported]) || "low";
        return {
          caseId: c.caseId,
          id: m.id,
          file: m.file,
          line: m.line,
          title: m.text,
          severity,
          verdict: "unlabeled" as const,
          notes: `variant=${results.variant}; source=${m.source}; bucket=${m.bucket}${m.severity ? `; reported severity=${m.severity}` : ""}`,
        };
      }),
  );
}
