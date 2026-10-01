/**
 * Stage 4, agentic mode (`reviewer.mode: agentic`): decides what happens
 * to each finding the agent reported, in place of the per-hunk finding
 * filter. Cheapest and most deterministic first; a finding leaves the
 * chain at the first step that drops it, with its reason:
 *
 * 1. Hard exclusions (../../../domain/hard-exclusions.ts) → `discarded`,
 *    reason `excluded (<rule>): <detail>`. Deterministic policy, so
 *    discarded whatever `findingFilter.mode` says.
 * 2. Evidence check (../../../domain/evidence-verifier.ts, the same one
 *    `reviewer.requireEvidence` uses): each quote is looked for in the
 *    redacted head file around its line, or in the file's diff for removed
 *    code. None found → low confidence (`discarded` in mode discard),
 *    reason {@link EVIDENCE_NOT_FOUND_REASON}.
 * 3. Optional LLM verifier (`reviewer.verifier`), at most
 *    {@link VERIFIER_CONCURRENCY} at a time: `refuted` → `discarded` with
 *    its reason; `uncertain` (also on a verifier error, or when the run's
 *    budget is spent) caps the finding at a question; `confirmed` goes on.
 * 4. Jev's staged judge (agentic-judge-questions.ts), one request per
 *    step, stopping at the first discard: `supports`, then `mechanism`,
 *    then `severity`, routed by ../../../domain/agentic-policy.ts. A Jev
 *    discard follows `findingFilter.mode` (low confidence in annotate),
 *    a question goes to `needsHuman`, publish to `published`. NFR-2: a Jev
 *    failure on a finding makes it an "unverified" question, never a
 *    published finding and never a failed run.
 *
 * The result has the per-hunk filter's shape (published / needsHuman /
 * lowConfidence / discarded, Jev totals), so the merge gate, the verdict,
 * the narrator, publish and the eval harness work unchanged. Lines are
 * HEAD-side; `agentic.inlineAnchor` says where an inline comment can go
 * (the finding's line, or a verified evidence line, when it is on a line
 * of the diff), `null` when neither is.
 */
import type { AgenticFinding, AgenticSeverity } from "../../../domain/agentic-finding.js";
import {
  type AgenticRoute,
  type VerifierDecision,
  routeAgenticFinding,
} from "../../../domain/agentic-policy.js";
import type { ChoiceDecision, ScoreDecision, Usage } from "../../../domain/decision.js";
import {
  EVIDENCE_LINE_TOLERANCE,
  type EvidenceItem,
  type EvidenceMatch,
  evidencePathCandidates,
  verifyEvidence,
} from "../../../domain/evidence-verifier.js";
import { hunkNewRange } from "../../../domain/file-context.js";
import { exclusionFor } from "../../../domain/hard-exclusions.js";
import { splitFileIntoHunks } from "../../../domain/hunk-splitter.js";
import type { JsonObject } from "../../../domain/json.js";
import type { AgentToolCall } from "../../../domain/ports/agentic-reviewer-port.js";
import type { DecisionPort } from "../../../domain/ports/decision-port.js";
import type { FindingVerifierPort } from "../../../domain/ports/finding-verifier-port.js";
import type { ReviewUsage } from "../../../domain/ports/reviewer-port.js";
import type { PullRequestData } from "../../../domain/pull-request.js";
import { redact } from "../../../domain/redact.js";
import {
  mechanismQuestion,
  severityQuestion,
  supportsQuestion,
} from "./agentic-judge-questions.js";
import type { HeadFileReader } from "./code-context.js";
import {
  type AgenticFindingDetail,
  EVIDENCE_NOT_FOUND_REASON,
  type FilteredFinding,
  type FindingFilterMode,
  type FindingFilterStageResult,
} from "./finding-filter.js";

/** Verifier agents running at once. */
export const VERIFIER_CONCURRENCY = 3;

export interface AgenticJudgeStageInput {
  readonly findings: readonly AgenticFinding[];
  readonly pr: PullRequestData;
  readonly decisionPort: DecisionPort;
  readonly mode: FindingFilterMode;
  /** Redacted head-file lines (createHeadFileReader); absent = check against the diff only. */
  readonly readHeadLines?: HeadFileReader | undefined;
  /** Present = `reviewer.verifier` is on. */
  readonly verifier?: FindingVerifierPort | undefined;
  /** The checkout the verifier runs in. */
  readonly repoRoot?: string | undefined;
  /** What is left of the per-run budget for verifier calls. */
  readonly verifierBudgetUsd: number;
  readonly verifierConcurrency?: number;
}

export interface AgenticJudgeOutcomes {
  readonly published: number;
  readonly questions: number;
  readonly low: number;
  readonly discarded: number;
}

export interface AgenticJudgeDetails {
  readonly reported: number;
  /** `exclusion:<rule>`, `evidence-not-found`, `verifier-refuted`, `judge:<policy code>` → count. */
  readonly dropsByReason: Readonly<Record<string, number>>;
  readonly outcomes: AgenticJudgeOutcomes;
  readonly verifierCalls: number;
  readonly verifierCostUsd: number;
  readonly verifierUsage: ReviewUsage;
  readonly verifierTurns: number;
  readonly verifierToolCalls: readonly AgentToolCall[];
  readonly jevJudgeCalls: number;
}

export interface AgenticJudgeStageResult {
  readonly filter: FindingFilterStageResult;
  readonly details: AgenticJudgeDetails;
}

type Outcome =
  | { readonly bucket: "published" | "needsHuman"; readonly route: string }
  | {
      readonly bucket: "lowConfidence" | "discarded";
      readonly route: string;
      readonly dropKey: string;
    };

interface Judged {
  readonly index: number;
  readonly finding: AgenticFinding;
  readonly outcome: Outcome;
  readonly evidenceVerified: number;
  readonly inlineAnchor: AgenticFindingDetail["inlineAnchor"];
  readonly verifier: AgenticFindingDetail["verifier"];
  readonly supports: (ChoiceDecision & { readonly requestId: string }) | null;
  readonly mechanism: ChoiceDecision | null;
  readonly severity: ScoreDecision | null;
  readonly unverified: boolean;
  readonly requestId: string;
}

const ZERO_USAGE: ReviewUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** Agent severity as a score on Jev's 0..3 scale, for questions Jev never scored. */
const REPORTED_SEVERITY_SCORE: Record<AgenticSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0.5,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Repo paths and their redacted patches / commentable head ranges. */
class ChangedFiles {
  private readonly patches = new Map<string, string>();
  private readonly ranges = new Map<string, { start: number; end: number }[]>();
  readonly paths: string[];

  constructor(pr: PullRequestData) {
    this.paths = pr.files.map((f) => f.path);
    for (const file of pr.files) {
      if (file.patch === undefined) continue;
      this.patches.set(file.path, redact(file.patch, { path: file.path }).text);
      const ranges = splitFileIntoHunks(file.path, file.patch)
        .map((h) => hunkNewRange(h.hunkHeader))
        .filter((r): r is { start: number; end: number } => r !== null);
      this.ranges.set(file.path, ranges);
    }
  }

  /** The changed path a cited path means, if any. */
  resolve(path: string): string | null {
    return evidencePathCandidates(path).find((p) => this.paths.includes(p)) ?? null;
  }

  patch(path: string): string {
    return this.patches.get(path) ?? "";
  }

  onDiffLine(path: string, line: number): boolean {
    const resolved = this.resolve(path);
    if (resolved === null) return false;
    return (this.ranges.get(resolved) ?? []).some((r) => line >= r.start && line <= r.end);
  }
}

interface CheckedEvidence {
  readonly item: EvidenceItem;
  readonly match: EvidenceMatch;
}

async function checkEvidence(
  finding: AgenticFinding,
  changed: ChangedFiles,
  readHeadLines: HeadFileReader | undefined,
): Promise<CheckedEvidence[]> {
  const checked: CheckedEvidence[] = [];
  for (const item of finding.evidence) {
    const candidates = evidencePathCandidates(item.file);
    const hunkFile = changed.resolve(item.file) ?? candidates[0] ?? item.file;
    let headFiles: Map<string, readonly string[] | null> | null = null;
    if (readHeadLines) {
      headFiles = new Map();
      for (const path of new Set([hunkFile, ...candidates])) {
        headFiles.set(path, await readHeadLines(path));
      }
    }
    const result = verifyEvidence([item], {
      hunk: { file: hunkFile, before: "", diff: changed.patch(hunkFile) },
      headFiles,
    });
    checked.push({ item, match: result.items[0]?.match ?? null });
  }
  return checked;
}

/** Each verified item's location ±{@link EVIDENCE_LINE_TOLERANCE} lines, re-read and redacted, merged per file. */
async function selectedEvidence(
  checked: readonly CheckedEvidence[],
  changed: ChangedFiles,
  readHeadLines: HeadFileReader | undefined,
): Promise<JsonObject[]> {
  const windows = new Map<string, Set<number>>();
  const loose: JsonObject[] = [];
  for (const { item, match } of checked) {
    if (match === null) continue;
    const path = changed.resolve(item.file) ?? evidencePathCandidates(item.file)[0] ?? item.file;
    const quote = redact(item.quote, { path }).text;
    if (match === "removed") {
      loose.push({ file: path, removedByThisChange: true, code: quote });
      continue;
    }
    const lines = readHeadLines ? await readHeadLines(path) : null;
    if (match === "hunk" || lines === null) {
      loose.push({ file: path, code: quote });
      continue;
    }
    const set = windows.get(path) ?? new Set<number>();
    const quoteLines = item.quote.split("\n").length;
    const from = Math.max(1, item.line - EVIDENCE_LINE_TOLERANCE);
    const to = Math.min(lines.length, item.line + EVIDENCE_LINE_TOLERANCE + quoteLines - 1);
    for (let n = from; n <= to; n++) set.add(n);
    windows.set(path, set);
  }
  const result: JsonObject[] = [];
  for (const [path, set] of windows) {
    const lines = (readHeadLines ? await readHeadLines(path) : null) ?? [];
    const sorted = [...set].sort((a, b) => a - b);
    let start = sorted[0];
    let prev = start;
    const flush = (s: number, e: number) => {
      const code = [];
      for (let n = s; n <= e; n++) code.push(`${n}| ${lines[n - 1] ?? ""}`);
      result.push({ file: path, lines: `${s}-${e}`, code: code.join("\n") });
    };
    for (const n of sorted.slice(1)) {
      if (prev !== undefined && n === prev + 1) {
        prev = n;
        continue;
      }
      if (start !== undefined && prev !== undefined) flush(start, prev);
      start = n;
      prev = n;
    }
    if (start !== undefined && prev !== undefined) flush(start, prev);
  }
  return [...result, ...loose];
}

function inlineAnchorFor(
  finding: AgenticFinding,
  checked: readonly CheckedEvidence[],
  changed: ChangedFiles,
): AgenticFindingDetail["inlineAnchor"] {
  if (changed.onDiffLine(finding.file, finding.line)) {
    return { path: changed.resolve(finding.file) ?? finding.file, line: finding.line };
  }
  for (const { item, match } of checked) {
    if (match !== "head" && match !== "hunk") continue;
    if (changed.onDiffLine(item.file, item.line)) {
      return { path: changed.resolve(item.file) ?? item.file, line: item.line };
    }
  }
  return null;
}

interface JevStep<D> {
  readonly decision: D;
  readonly requestId: string;
  readonly latencyMs: number;
  readonly usage: Usage;
}

export async function runAgenticJudgeStage(
  input: AgenticJudgeStageInput,
): Promise<AgenticJudgeStageResult> {
  const changed = new ChangedFiles(input.pr);
  const prId = `${input.pr.ref.owner}/${input.pr.ref.repo}#${input.pr.ref.number}`;
  const latencies: number[] = [];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let jevCalls = 0;
  let verifierCalls = 0;
  let verifierCostUsd = 0;
  let verifierTurns = 0;
  let verifierUsage: ReviewUsage = ZERO_USAGE;
  const verifierToolCalls: AgentToolCall[] = [];

  async function ask<D extends ChoiceDecision | ScoreDecision>(
    key: string,
    state: JsonObject,
    question: Parameters<DecisionPort["decide"]>[1][string],
  ): Promise<JevStep<D>> {
    jevCalls += 1;
    const response = await input.decisionPort.decide(state, { [key]: question });
    latencies.push(response.latencyMs);
    usage = {
      inputTokens: usage.inputTokens + response.usage.inputTokens,
      outputTokens: usage.outputTokens + response.usage.outputTokens,
    };
    const decision = response.answers[key] as D | undefined;
    if (decision === undefined) throw new Error(`Jev returned no answer for "${key}"`);
    return {
      decision,
      requestId: response.requestId,
      latencyMs: response.latencyMs,
      usage: response.usage,
    };
  }

  // Steps 1-2: deterministic.
  type Pending = {
    index: number;
    finding: AgenticFinding;
    checked: CheckedEvidence[];
    evidenceVerified: number;
    inlineAnchor: AgenticFindingDetail["inlineAnchor"];
  };
  const judged: Judged[] = [];
  const pending: Pending[] = [];
  const empty = {
    evidenceVerified: 0,
    inlineAnchor: null,
    verifier: null,
    supports: null,
    mechanism: null,
    severity: null,
    unverified: false,
    requestId: "",
  };
  for (const [index, finding] of input.findings.entries()) {
    const exclusion = exclusionFor(finding, changed.paths);
    if (exclusion !== null) {
      judged.push({
        ...empty,
        index,
        finding,
        outcome: {
          bucket: "discarded",
          route: `excluded (${exclusion.reason}): ${exclusion.detail}`,
          dropKey: `exclusion:${exclusion.reason}`,
        },
      });
      continue;
    }
    const checked = await checkEvidence(finding, changed, input.readHeadLines);
    const evidenceVerified = checked.filter((c) => c.match !== null).length;
    const inlineAnchor = inlineAnchorFor(finding, checked, changed);
    if (evidenceVerified === 0) {
      judged.push({
        ...empty,
        index,
        finding,
        inlineAnchor,
        outcome: {
          bucket: input.mode === "discard" ? "discarded" : "lowConfidence",
          route: EVIDENCE_NOT_FOUND_REASON,
          dropKey: "evidence-not-found",
        },
      });
      continue;
    }
    pending.push({ index, finding, checked, evidenceVerified, inlineAnchor });
  }

  // Step 3: the optional LLM verifier, bounded concurrency.
  const verifierAnswers = new Map<number, { decision: VerifierDecision; reason: string }>();
  if (input.verifier !== undefined && input.repoRoot !== undefined) {
    const verifier = input.verifier;
    const repoRoot = input.repoRoot;
    await mapWithConcurrency(
      pending,
      input.verifierConcurrency ?? VERIFIER_CONCURRENCY,
      async (p) => {
        if (verifierCostUsd >= input.verifierBudgetUsd) {
          verifierAnswers.set(p.index, {
            decision: "uncertain",
            reason: "verifier skipped: the per-run budget is spent",
          });
          return;
        }
        verifierCalls += 1;
        try {
          const out = await verifier.verify({
            itemId: `${prId}:agentic-f${p.index}`,
            repoRoot,
            finding: p.finding,
            changedFiles: changed.paths,
          });
          verifierCostUsd += out.nominalCostUsd;
          verifierTurns += out.turns;
          verifierToolCalls.push(...out.toolCalls);
          verifierUsage = {
            inputTokens: verifierUsage.inputTokens + out.usage.inputTokens,
            outputTokens: verifierUsage.outputTokens + out.usage.outputTokens,
            cacheReadInputTokens:
              verifierUsage.cacheReadInputTokens + out.usage.cacheReadInputTokens,
            cacheCreationInputTokens:
              verifierUsage.cacheCreationInputTokens + out.usage.cacheCreationInputTokens,
          };
          verifierAnswers.set(p.index, { decision: out.decision, reason: out.reason });
        } catch (error) {
          verifierAnswers.set(p.index, {
            decision: "uncertain",
            reason: `verifier failed: ${errorMessage(error)}`,
          });
        }
      },
    );
  }

  // Step 4: Jev's staged judge, one finding at a time.
  for (const p of pending) {
    const verifier = verifierAnswers.get(p.index) ?? null;
    const base = {
      index: p.index,
      finding: p.finding,
      evidenceVerified: p.evidenceVerified,
      inlineAnchor: p.inlineAnchor,
      verifier,
    };
    if (verifier?.decision === "refuted") {
      judged.push({
        ...empty,
        ...base,
        outcome: {
          bucket: "discarded",
          route: `refuted by the verifier: ${verifier.reason}`,
          dropKey: "verifier-refuted",
        },
      });
      continue;
    }
    const state: JsonObject = {
      finding: {
        file: p.finding.file,
        line: p.finding.line,
        category: p.finding.category,
        claim: p.finding.claim,
        failingScenario: p.finding.failingScenario,
      },
      selectedEvidence: await selectedEvidence(p.checked, changed, input.readHeadLines),
    };
    let supports: JevStep<ChoiceDecision> | null = null;
    let mechanism: JevStep<ChoiceDecision> | null = null;
    let severity: JevStep<ScoreDecision> | null = null;
    let route: AgenticRoute | "next" = "next";
    try {
      const routeInput = () => ({
        supports: {
          choice: supports?.decision.choice ?? "",
          confidence: supports?.decision.confidence ?? 0,
        },
        mechanism: mechanism
          ? { choice: mechanism.decision.choice, confidence: mechanism.decision.confidence }
          : undefined,
        severity: severity
          ? { score: severity.decision.score, confidence: severity.decision.confidence }
          : undefined,
        verifier: verifier?.decision ?? ("none" as const),
        agentSeverity: p.finding.severity,
      });
      supports = await ask<ChoiceDecision>("supports", state, supportsQuestion());
      route = routeAgenticFinding(routeInput());
      if (route === "next") {
        mechanism = await ask<ChoiceDecision>(
          "mechanism",
          state,
          mechanismQuestion(p.finding.category),
        );
        route = routeAgenticFinding(routeInput());
      }
      if (route === "next") {
        severity = await ask<ScoreDecision>(
          "severity",
          { ...state, mechanism: mechanism?.decision.choice ?? null },
          severityQuestion(),
        );
        route = routeAgenticFinding(routeInput());
      }
    } catch (error) {
      console.warn(
        `jevest: Jev failed judging agentic finding ${p.index} (${errorMessage(error)})`,
      );
      route = "next";
    }
    const jevFields = {
      supports: supports ? { ...supports.decision, requestId: supports.requestId } : null,
      mechanism: mechanism?.decision ?? null,
      severity: severity?.decision ?? null,
      requestId: severity?.requestId ?? mechanism?.requestId ?? supports?.requestId ?? "",
    };
    if (route === "next") {
      judged.push({
        ...base,
        ...jevFields,
        unverified: true,
        outcome: { bucket: "needsHuman", route: "unverified: Jev did not answer (NFR-2)" },
      });
      continue;
    }
    const outcome: Outcome =
      route.route === "publish"
        ? { bucket: "published", route: route.reason }
        : route.route === "question"
          ? { bucket: "needsHuman", route: route.reason }
          : {
              bucket: input.mode === "discard" ? "discarded" : "lowConfidence",
              route: route.reason,
              dropKey: `judge:${route.code}`,
            };
    judged.push({ ...base, ...jevFields, unverified: false, outcome });
  }

  judged.sort((a, b) => a.index - b.index);
  const buckets: Record<Outcome["bucket"], FilteredFinding[]> = {
    published: [],
    needsHuman: [],
    lowConfidence: [],
    discarded: [],
  };
  const dropsByReason: Record<string, number> = {};
  for (const j of judged) {
    const filtered = toFiltered(j);
    buckets[j.outcome.bucket].push(filtered);
    if ("dropKey" in j.outcome) {
      dropsByReason[j.outcome.dropKey] = (dropsByReason[j.outcome.dropKey] ?? 0) + 1;
    }
  }

  return {
    filter: {
      published: buckets.published,
      needsHuman: buckets.needsHuman,
      lowConfidence: buckets.lowConfidence,
      discarded: buckets.discarded,
      totalRequests: latencies.length,
      totalLatencyMs: latencies.reduce((a, b) => a + b, 0),
      totalUsage: usage,
      requestLatenciesMs: latencies,
    },
    details: {
      reported: input.findings.length,
      dropsByReason,
      outcomes: {
        published: buckets.published.length,
        questions: buckets.needsHuman.length,
        low: buckets.lowConfidence.length,
        discarded: buckets.discarded.length,
      },
      verifierCalls,
      verifierCostUsd,
      verifierUsage,
      verifierTurns,
      verifierToolCalls,
      jevJudgeCalls: jevCalls,
    },
  };
}

function toFiltered(j: Judged): FilteredFinding {
  const { finding, outcome } = j;
  const provesProb = j.supports ? (j.supports.probabilities.proves ?? 0) : Number.NaN;
  const dropped = outcome.bucket === "lowConfidence" || outcome.bucket === "discarded";
  return {
    findingId: `agentic-f${j.index}`,
    hunkId: "agentic",
    file: finding.file,
    lineStart: finding.line,
    lineEnd: Math.max(finding.line, finding.lineEnd ?? finding.line),
    claim: finding.claim,
    rationale: finding.failingScenario,
    isRealDefectProb: provesProb,
    rawIsRealDefectProb: provesProb,
    jevSeverityScore: j.severity?.score ?? REPORTED_SEVERITY_SCORE[finding.severity],
    isStyleOnlyProb: Number.NaN,
    actionableProb: Number.NaN,
    requestId: j.requestId,
    unverified: j.unverified,
    ...(dropped ? { rejectedReason: outcome.route } : {}),
    agentic: {
      category: finding.category,
      reportedSeverity: finding.severity,
      confidence: finding.confidence,
      evidence: finding.evidence,
      evidenceVerified: j.evidenceVerified,
      inlineAnchor: j.inlineAnchor,
      verifier: j.verifier,
      supports: j.supports
        ? { choice: j.supports.choice, confidence: j.supports.confidence }
        : null,
      mechanism: j.mechanism
        ? { choice: j.mechanism.choice, confidence: j.mechanism.confidence }
        : null,
      severity: j.severity ? { score: j.severity.score, confidence: j.severity.confidence } : null,
      route: outcome.route,
    },
  };
}
