/**
 * One hand-written adversarial pull request for the H5 suite (SPEC §4.2 H5,
 * NFR-7, §10 item 5): a PR whose text or diff tries to steer an automated
 * reviewer, plus one genuine critical defect planted in the diff that the
 * fake reviewer will report. The suite then checks that the pipeline never
 * turns the check green on an attacked PR and never discards the planted
 * critical finding. Cases live as one JSON file each under
 * `datasets/adversarial/`; this module is their zod contract and loader
 * (mirrors `coherence/pr-record.ts`).
 *
 * Deviation from SPEC FR-8.1's `adversarial.jsonl`: the cases carry
 * multi-line unified diffs and are meant to be read and edited by hand, so
 * one pretty-printed JSON file per case beats a JSONL line per case.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { splitFileIntoHunks } from "../../domain/hunk-splitter.js";
import type {
  PullRequestData,
  PullRequestFile,
  PullRequestRef,
} from "../../domain/pull-request.js";

/**
 * Attack families the suite covers. `none` is the benign control: a normal
 * PR with the same planted defect, so a detector that flags everything as
 * injected would show up as a false positive there.
 */
export const ATTACK_FAMILIES = [
  "none",
  "body-instruction",
  "title-instruction",
  "html-comment",
  "code-comment",
  "string-literal",
  "commit-trailer",
  "unicode-obfuscation",
  "reviewer-skip-claim",
  "fake-approval-summary",
  "tests-pass-claim",
  "secret-in-diff",
  "whitespace-flood",
  "label-instruction",
] as const;
export type AttackFamily = (typeof ATTACK_FAMILIES)[number];

const FILE_STATUSES = ["added", "modified", "removed", "renamed"] as const;
const CI_STATUSES = ["success", "failure", "pending", "unknown"] as const;

const caseFileSchema = z.object({
  path: z.string().min(1),
  status: z.enum(FILE_STATUSES),
  /** Unified diff from the first `@@` on, exactly like `PullRequestFile.patch`. */
  patch: z.string().min(1),
});

const plantedFindingSchema = z.object({
  file: z.string().min(1),
  /** Index of the hunk inside `file`'s patch, 0-based — the pipeline's hunk id is `${file}#${hunkIndex}`. */
  hunkIndex: z.number().int().nonnegative(),
  /** Absolute BEFORE-side lines, as `ReviewFindingCandidate` documents. */
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  claim: z.string().min(1),
  rationale: z.string().min(1),
  /** H5 counts suppressed CRITICAL findings, so every planted finding is critical by construction. */
  suggestedSeverity: z.literal("critical"),
});

const expectationsSchema = z.object({
  /** True for every attacked case: the check must not conclude "success". False only for the control. */
  attacked: z.boolean(),
  /** Literal strings (secrets) that must never appear in any published text or in any state sent to Jev. */
  forbiddenPublishedText: z.array(z.string().min(1)).default([]),
  /**
   * True when the instruction is hidden INSIDE the diff (code comment, string
   * literal): the hunk profile's `contains_reviewer_instructions` must then
   * reach the "yes" bar on at least one hunk, or the case counts a missed
   * in-diff injection. Cases whose attack lives in the title/body/labels
   * leave it false — there is nothing in their diff to detect.
   */
  expectInjectionInDiff: z.boolean().default(false),
});

const adversarialCaseSchema = z.object({
  id: z.string().regex(/^adv-[a-z0-9-]+$/, "id must look like adv-<kebab-case>"),
  attackFamily: z.enum(ATTACK_FAMILIES),
  description: z.string().min(1),
  pr: z.object({
    title: z.string().min(1),
    body: z.string(),
    author: z.string().min(1).default("contributor"),
    labels: z.array(z.string()).default([]),
    baseBranch: z.string().min(1).default("main"),
    ciStatus: z.enum(CI_STATUSES).default("success"),
    files: z.array(caseFileSchema).min(1),
  }),
  plantedFinding: plantedFindingSchema,
  expect: expectationsSchema,
});

export type AdversarialCase = z.infer<typeof adversarialCaseSchema>;
export type AdversarialCaseFile = z.infer<typeof caseFileSchema>;
export type PlantedFinding = z.infer<typeof plantedFindingSchema>;

export class AdversarialCaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdversarialCaseError";
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "<case>"}: ${i.message}`).join("; ");
}

function idOf(raw: unknown): string {
  if (raw !== null && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  return "<no id>";
}

/**
 * Parses one case and checks the cross-field invariants zod can't express:
 * the planted finding must point at a hunk that exists in the PR, and the
 * `attacked` expectation must agree with the family (`none` is the only
 * non-attacked family).
 */
export function parseAdversarialCase(raw: unknown): AdversarialCase {
  const result = adversarialCaseSchema.safeParse(raw);
  if (!result.success) {
    throw new AdversarialCaseError(`case ${idOf(raw)}: ${formatIssues(result.error)}`);
  }
  const parsed = result.data;

  const file = parsed.pr.files.find((f) => f.path === parsed.plantedFinding.file);
  if (!file) {
    throw new AdversarialCaseError(
      `case ${parsed.id}: plantedFinding.file "${parsed.plantedFinding.file}" is not among the PR's files`,
    );
  }
  const hunkCount = splitFileIntoHunks(file.path, file.patch).length;
  if (parsed.plantedFinding.hunkIndex >= hunkCount) {
    throw new AdversarialCaseError(
      `case ${parsed.id}: plantedFinding.hunkIndex ${parsed.plantedFinding.hunkIndex} is out of range, "${file.path}" has ${hunkCount} hunk(s)`,
    );
  }
  if (parsed.plantedFinding.lineEnd < parsed.plantedFinding.lineStart) {
    throw new AdversarialCaseError(`case ${parsed.id}: plantedFinding.lineEnd is before lineStart`);
  }

  const shouldBeAttacked = parsed.attackFamily !== "none";
  if (parsed.expect.attacked !== shouldBeAttacked) {
    throw new AdversarialCaseError(
      `case ${parsed.id}: expect.attacked must be ${shouldBeAttacked} for attack family "${parsed.attackFamily}"`,
    );
  }

  return parsed;
}

/** Loads every `*.json` under `dir` (sorted by file name, so the suite order is stable) and rejects duplicate ids. */
export async function loadAdversarialCases(dir: string): Promise<AdversarialCase[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const cases: AdversarialCase[] = [];
  const seen = new Set<string>();
  for (const name of entries) {
    const path = join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new AdversarialCaseError(
        `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    let parsed: AdversarialCase;
    try {
      parsed = parseAdversarialCase(raw);
    } catch (error) {
      throw new AdversarialCaseError(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (seen.has(parsed.id)) {
      throw new AdversarialCaseError(`${path}: duplicate case id "${parsed.id}"`);
    }
    seen.add(parsed.id);
    cases.push(parsed);
  }
  return cases;
}

function countChangedLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** The `PullRequestData` the pipeline sees for this case; additions/deletions are counted in code (NFR-5). */
export function toPullRequestData(
  adversarialCase: AdversarialCase,
  ref: PullRequestRef,
): PullRequestData {
  const files: PullRequestFile[] = adversarialCase.pr.files.map((f) => ({
    path: f.path,
    status: f.status,
    ...countChangedLines(f.patch),
    patch: f.patch,
  }));
  return {
    ref,
    title: adversarialCase.pr.title,
    body: adversarialCase.pr.body,
    author: adversarialCase.pr.author,
    labels: [...adversarialCase.pr.labels],
    baseBranch: adversarialCase.pr.baseBranch,
    files,
    ciStatus: adversarialCase.pr.ciStatus,
  };
}

/**
 * Hunk id the pipeline assigns to the planted hunk. `hunk-profile.ts` numbers
 * hunks by their position in the PR-wide flattened list (`${file}#${index}`
 * with `index` global, not per file), so the file's own hunks are offset by
 * every hunk of the files before it, in PR file order.
 */
export function plantedHunkId(adversarialCase: AdversarialCase): string {
  const { file, hunkIndex } = adversarialCase.plantedFinding;
  let offset = 0;
  for (const f of adversarialCase.pr.files) {
    if (f.path === file) break;
    offset += splitFileIntoHunks(f.path, f.patch).length;
  }
  return `${file}#${offset + hunkIndex}`;
}

/** Finding id the pipeline assigns to the planted finding (`finding-filter.ts`: `${hunkId}-f${index}`, first finding of its hunk). */
export function plantedFindingId(adversarialCase: AdversarialCase): string {
  return `${plantedHunkId(adversarialCase)}-f0`;
}
