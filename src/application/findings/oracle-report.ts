/**
 * Report for a fix-aware oracle labeling pass (datasets/FINDINGS.md §10).
 *
 * The centrepiece is the cross-tab of the OLD label against the NEW one. The
 * oracle pass exists because the line-overlap label failed as ground truth, so
 * the first thing anyone will ask is "how much did the label actually move?".
 * A cross-tab answers that directly, and a low agreement rate is the evidence
 * that re-scoring H1 against the oracle is worth doing at all — if the two
 * labels agreed everywhere, the new one would just reproduce the old verdict.
 *
 * Agreement is computed over the DECISIVE oracle verdicts only. `unknown` has
 * no counterpart in a two-valued label, so counting it as a disagreement would
 * understate agreement and counting it as agreement would invent one.
 */
import type { FindingRecord } from "../filter/finding-record.js";
import {
  type OracleRunResult,
  type OracleRunSummary,
  type OracleVerdict,
  summarizeOracleRun,
} from "./oracle-label.js";

export interface OracleVerdictCounts {
  readonly real: number;
  readonly noise: number;
  readonly unknown: number;
}

export interface OracleCrossTab {
  /** Findings the line-overlap label called real, split by oracle verdict. */
  readonly lineOverlapReal: OracleVerdictCounts;
  /** Findings the line-overlap label called noise, split by oracle verdict. */
  readonly lineOverlapNoise: OracleVerdictCounts;
}

export interface OracleReport {
  readonly generatedAt: string;
  readonly datasetVersion: number;
  readonly summary: OracleRunSummary;
  readonly crossTab: OracleCrossTab;
  /** Findings with BOTH a line-overlap label and a decisive oracle verdict. */
  readonly comparableCount: number;
  /** Of those, the share where the two labels say the same thing. */
  readonly labelAgreementRate: number;
  readonly failures: readonly { readonly findingId: string; readonly error: string }[];
  readonly stoppedEarly: boolean;
  readonly stopReason?: string;
}

export interface BuildOracleReportOptions {
  readonly now?: () => Date;
  readonly datasetVersion?: number;
}

export function buildOracleReport(
  run: OracleRunResult,
  findings: readonly FindingRecord[],
  options: BuildOracleReportOptions = {},
): OracleReport {
  const now = options.now ?? (() => new Date());
  const lineOverlapById = new Map(findings.map((f) => [f.id, f.label.real]));

  const crossTab: { lineOverlapReal: OracleVerdictCounts; lineOverlapNoise: OracleVerdictCounts } =
    {
      lineOverlapReal: { real: 0, noise: 0, unknown: 0 },
      lineOverlapNoise: { real: 0, noise: 0, unknown: 0 },
    };
  let comparableCount = 0;
  let agreements = 0;

  for (const result of run.results) {
    const lineOverlapReal = lineOverlapById.get(result.findingId);
    if (lineOverlapReal === undefined) continue;
    const row = lineOverlapReal ? crossTab.lineOverlapReal : crossTab.lineOverlapNoise;
    (row as { real: number; noise: number; unknown: number })[result.verdict] += 1;
    if (result.verdict === "unknown") continue;
    comparableCount += 1;
    if ((result.verdict === "real") === lineOverlapReal) {
      agreements += 1;
    }
  }

  return {
    generatedAt: now().toISOString(),
    datasetVersion: options.datasetVersion ?? findings[0]?.datasetVersion ?? 2,
    summary: summarizeOracleRun(run),
    crossTab,
    comparableCount,
    labelAgreementRate: comparableCount === 0 ? 0 : agreements / comparableCount,
    failures: run.failures,
    stoppedEarly: run.stoppedEarly,
    ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
  };
}

function row(label: string, counts: OracleVerdictCounts): string {
  const total = counts.real + counts.noise + counts.unknown;
  return `| ${label} | ${counts.real} | ${counts.noise} | ${counts.unknown} | ${total} |`;
}

export function renderOracleReportMarkdown(report: OracleReport): string {
  const s = report.summary;
  const lines: string[] = [];

  lines.push("# Fix-aware oracle label pass (H1 ground truth)");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Dataset version: ${report.datasetVersion}`);
  lines.push(`Labeler model: ${s.labelerModel || "n/a"}`);
  lines.push("");
  lines.push("| Verdict | Count | Share |");
  lines.push("|---|---|---|");
  for (const verdict of ["real", "noise", "unknown"] as const) {
    const count = s.counts[verdict];
    const share = s.labeled === 0 ? 0 : count / s.labeled;
    lines.push(`| ${verdict} | ${count} | ${(share * 100).toFixed(1)}% |`);
  }
  lines.push(`| **labeled** | **${s.labeled}** | |`);
  lines.push("");
  lines.push(
    `Pass agreement (the two framings reached a decisive verdict): ${(s.agreementRate * 100).toFixed(1)}%. ` +
      `\`unknown\` share: ${(s.unknownShare * 100).toFixed(1)}% — those findings are **excluded** from H1/H3/H6 scoring, not counted as noise.`,
  );
  lines.push("");
  lines.push(
    `Cost: $${s.totalCostUsd.toFixed(4)} over ${report.summary.labeled * 2} calls. ` +
      `Wall time ${(s.wallTimeMs / 1000).toFixed(1)}s. Latency per finding (both passes) p50=${s.latencyP50.toFixed(0)}ms p95=${s.latencyP95.toFixed(0)}ms.`,
  );
  lines.push("");

  lines.push("## Cross-tab: line-overlap × oracle");
  lines.push("");
  lines.push("| line-overlap \\ oracle | real | noise | unknown | total |");
  lines.push("|---|---|---|---|---|");
  lines.push(row("real", report.crossTab.lineOverlapReal));
  lines.push(row("noise", report.crossTab.lineOverlapNoise));
  lines.push("");
  lines.push(
    `The two labels agree on ${(report.labelAgreementRate * 100).toFixed(1)}% of the ${report.comparableCount} findings where both are decisive. Anything well below 100% means the H1 numbers reported against line-overlap were measuring a different question.`,
  );
  lines.push("");

  if (report.failures.length > 0) {
    lines.push(`## Failures (${report.failures.length})`);
    lines.push("");
    for (const failure of report.failures.slice(0, 20)) {
      lines.push(`- \`${failure.findingId}\`: ${failure.error}`);
    }
    if (report.failures.length > 20) {
      lines.push(`- ... and ${report.failures.length - 20} more`);
    }
    lines.push("");
  }

  if (report.stoppedEarly) {
    lines.push(`**STOPPED EARLY**: ${report.stopReason ?? "unknown reason"}`);
    lines.push("");
  }

  lines.push(
    "Score the filter against this label with `pnpm filter --label oracle`; `--label line-overlap` (the default) keeps the old numbers reproducible.",
  );

  return lines.join("\n");
}
