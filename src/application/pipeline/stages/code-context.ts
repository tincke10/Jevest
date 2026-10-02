/**
 * Stage 3a (opt-in, before the review): code context for the reviewer from
 * the working tree at the PR head. `reviewer.hunks.fullFile` adds the hunk's
 * whole file (../../../domain/file-context.ts); `reviewer.hunks.impactContext`
 * adds the other code that references what the hunk changes — changed
 * symbols (../../../domain/changed-symbols.ts), one search per hunk through
 * WorkingTreePort, ranked and cut into snippets
 * (../../../domain/impact-context.ts). No LLM call and no Jev call: the
 * cost is the bigger review prompt, counted in the run's metrics.
 *
 * Every file read is redacted (NFR-3) before anything is built from it, so
 * the reviewer never sees a secret the hunk's own redaction would have
 * removed. Without a working tree (the Action without a checkout of the
 * head) nothing is built and `unavailable` carries the one line the
 * comment shows. A failure on one hunk (an unreadable tree, an rg error)
 * is recorded on that hunk and never fails the run.
 */
import { extractChangedSymbols } from "../../../domain/changed-symbols.js";
import {
  type FullFileContext,
  buildFullFileContext,
  fileLines,
  hunkNewRange,
} from "../../../domain/file-context.js";
import {
  type ImpactContext,
  buildImpactSnippets,
  rankImpactMatches,
} from "../../../domain/impact-context.js";
import type { WorkingTreePort } from "../../../domain/ports/working-tree-port.js";
import { redact } from "../../../domain/redact.js";
import type { HunkProfileEntry } from "./hunk-profile.js";

/** The comment line when a layer was asked for but there is no checkout; the reason follows a colon. */
export const CODE_CONTEXT_UNAVAILABLE_PREFIX = "Impact context unavailable";

export interface CodeContextHunk {
  readonly hunkId: string;
  readonly file: string;
  /** `null` when the layer is off, the file is not in the tree, or the hunk failed. */
  readonly fullFile: FullFileContext | null;
  /** `null` when the layer is off, no symbol was recognized, or the hunk failed. */
  readonly impactContext: ImpactContext | null;
  /** The symbols searched; empty when impact context is off. */
  readonly symbols: readonly string[];
  /** Raw matches the search returned, before ranking and caps. */
  readonly matchesFound: number;
  readonly error: string | null;
}

export interface CodeContextTotals {
  /** Hunks that got any context. */
  readonly hunks: number;
  /** Distinct files the added context comes from (full files and snippets). */
  readonly files: number;
  readonly snippets: number;
  readonly fullFileChars: number;
  readonly impactChars: number;
}

export interface CodeContextStageResult {
  readonly hunks: readonly CodeContextHunk[];
  /** `"Impact context unavailable: <reason>"` when there was no working tree; `null` otherwise. */
  readonly unavailable: string | null;
  readonly totals: CodeContextTotals;
}

export interface CodeContextStageInput {
  readonly hunks: readonly HunkProfileEntry[];
  /** The checkout of the PR head; absent = unavailable. */
  readonly workingTree?: WorkingTreePort;
  /** Why there is no working tree, for the comment line. Default "no checkout". */
  readonly unavailableReason?: string;
  readonly fullFile: boolean;
  readonly impactContext: boolean;
}

const ZERO_TOTALS: CodeContextTotals = {
  hunks: 0,
  files: 0,
  snippets: 0,
  fullFileChars: 0,
  impactChars: 0,
};

/** Redacted lines of a head file, cached per path; `null` when not readable. */
export type HeadFileReader = (path: string) => Promise<readonly string[] | null>;

export function createHeadFileReader(workingTree: WorkingTreePort): HeadFileReader {
  const cache = new Map<string, Promise<readonly string[] | null>>();
  return (path: string) => {
    let pending = cache.get(path);
    if (pending === undefined) {
      pending = workingTree
        .readFile(path)
        .then((text) => (text === null ? null : fileLines(redact(text, { path }).text)))
        .catch(() => null);
      cache.set(path, pending);
    }
    return pending;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function contextForHunk(
  hunk: HunkProfileEntry,
  input: CodeContextStageInput,
  workingTree: WorkingTreePort,
  readLines: HeadFileReader,
): Promise<CodeContextHunk> {
  const range = hunkNewRange(hunk.hunkHeader) ?? { start: hunk.newStart, end: hunk.newStart };
  let fullFile: FullFileContext | null = null;
  let impactContext: ImpactContext | null = null;
  let symbols: string[] = [];
  let matchesFound = 0;
  try {
    if (input.fullFile) {
      const lines = await readLines(hunk.file);
      if (lines !== null) fullFile = buildFullFileContext(hunk.file, lines.join("\n"), range);
    }
    if (input.impactContext) {
      symbols = extractChangedSymbols(hunk);
      if (symbols.length > 0) {
        const matches = await workingTree.searchSymbols(symbols);
        matchesFound = matches.length;
        const ranked = rankImpactMatches(matches, { file: hunk.file, range }, symbols);
        const files = new Map<string, readonly string[]>();
        for (const file of new Set(ranked.map((m) => m.file))) {
          const lines = await readLines(file);
          if (lines !== null) files.set(file, lines);
        }
        const { snippets, chars, truncated } = buildImpactSnippets(ranked, files);
        impactContext = { symbols, snippets, chars, truncated };
      }
    }
    return {
      hunkId: hunk.id,
      file: hunk.file,
      fullFile,
      impactContext,
      symbols,
      matchesFound,
      error: null,
    };
  } catch (error) {
    return {
      hunkId: hunk.id,
      file: hunk.file,
      fullFile,
      impactContext: null,
      symbols,
      matchesFound,
      error: errorMessage(error),
    };
  }
}

function totalsOf(hunks: readonly CodeContextHunk[]): CodeContextTotals {
  const files = new Set<string>();
  let withContext = 0;
  let snippets = 0;
  let fullFileChars = 0;
  let impactChars = 0;
  for (const hunk of hunks) {
    if (hunk.fullFile) {
      files.add(hunk.fullFile.path);
      fullFileChars += hunk.fullFile.chars;
    }
    if (hunk.impactContext) {
      impactChars += hunk.impactContext.chars;
      snippets += hunk.impactContext.snippets.length;
      for (const snippet of hunk.impactContext.snippets) files.add(snippet.file);
    }
    if (hunk.fullFile || (hunk.impactContext && hunk.impactContext.snippets.length > 0)) {
      withContext++;
    }
  }
  return { hunks: withContext, files: files.size, snippets, fullFileChars, impactChars };
}

export async function runCodeContextStage(
  input: CodeContextStageInput,
): Promise<CodeContextStageResult> {
  const { workingTree } = input;
  if (workingTree === undefined) {
    return {
      hunks: [],
      unavailable: `${CODE_CONTEXT_UNAVAILABLE_PREFIX}: ${input.unavailableReason ?? "no checkout"}`,
      totals: ZERO_TOTALS,
    };
  }
  const readLines = createHeadFileReader(workingTree);
  const hunks: CodeContextHunk[] = [];
  for (const hunk of input.hunks) {
    if (hunk.skippedFromReview) continue;
    hunks.push(await contextForHunk(hunk, input, workingTree, readLines));
  }
  return { hunks, unavailable: null, totals: totalsOf(hunks) };
}
