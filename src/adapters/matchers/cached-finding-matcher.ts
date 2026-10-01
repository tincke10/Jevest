/**
 * On-disk cache in front of a FindingMatcherPort (docs/EVAL.md
 * "Matching"): one `<sha256>.json` per decision, keyed by
 * {@link MATCHER_CACHE_VERSION}, everything the matcher is shown (each
 * offered issue's id, locations, title, category, verdict and notes; the
 * candidate's location, text, claim, failing scenario and evidence), the
 * matcher model and its effort. Re-scoring a run, or scoring a new variant
 * whose findings repeat an old one's, costs nothing. Delete the directory
 * to re-match.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FindingMatch,
  FindingMatchInput,
  FindingMatcherPort,
} from "../../domain/ports/finding-matcher-port.js";

/**
 * Bumped whenever the matcher's prompt, schema or input changes meaning, so
 * no decision made under an older contract is replayed. 2: notes, category,
 * verdict, locations, claim/failing scenario/evidence, the same-root-cause
 * rule and the decision-first schema.
 */
export const MATCHER_CACHE_VERSION = 2;

export function matcherCacheKey(input: FindingMatchInput, model: string, effort?: string): string {
  const issues = [...input.goldenIssues]
    .map((issue) => [
      issue.id,
      issue.file,
      issue.line,
      issue.locations ?? [],
      issue.title,
      issue.category ?? null,
      issue.verdict ?? null,
      issue.notes ?? null,
    ])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const { candidate } = input;
  const payload = JSON.stringify({
    version: MATCHER_CACHE_VERSION,
    model,
    effort: effort ?? null,
    issues,
    candidate: [
      candidate.file,
      candidate.line,
      candidate.text,
      candidate.claim ?? null,
      candidate.failingScenario ?? null,
      candidate.evidence ?? [],
    ],
  });
  return createHash("sha256").update(payload).digest("hex");
}

export interface CachedFindingMatcherOptions {
  readonly inner: FindingMatcherPort;
  readonly dir: string;
  /** Part of the key: a decision by one model never replays for another. */
  readonly model: string;
  /** Part of the key too, when the matcher runs at an explicit effort. */
  readonly effort?: string;
}

interface CacheEntry {
  readonly version: number;
  readonly issueId: string | null;
  readonly model: string;
  readonly effort?: string;
  readonly reason?: string;
}

let tmpCounter = 0;

export function createCachedFindingMatcher(
  options: CachedFindingMatcherOptions,
): FindingMatcherPort {
  return {
    async match(input: FindingMatchInput): Promise<FindingMatch> {
      const key = matcherCacheKey(input, options.model, options.effort);
      const path = join(options.dir, `${key}.json`);
      try {
        const entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
        return {
          issueId: entry.issueId,
          costUsd: 0,
          cached: true,
          ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
        };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const decision = await options.inner.match(input);
      await mkdir(options.dir, { recursive: true });
      const entry: CacheEntry = {
        version: MATCHER_CACHE_VERSION,
        issueId: decision.issueId,
        model: options.model,
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      };
      // Atomic: with concurrent cases two writers may hit the same key, and a
      // reader must never see a half-written file.
      const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
      await writeFile(tmp, `${JSON.stringify(entry)}\n`, "utf8");
      await rename(tmp, path);
      return decision;
    },
  };
}
