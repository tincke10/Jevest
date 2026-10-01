/**
 * On-disk cache in front of a FindingMatcherPort (docs/EVAL.md
 * "Matching"): one `<sha256>.json` per decision, keyed by the offered
 * issues' ids and titles, the candidate's location and text, and the
 * matcher model. Re-scoring a run, or scoring a new variant whose findings
 * repeat an old one's, costs nothing. Delete the directory to re-match.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FindingMatch,
  FindingMatchInput,
  FindingMatcherPort,
} from "../../domain/ports/finding-matcher-port.js";

export function matcherCacheKey(input: FindingMatchInput, model: string): string {
  const issues = [...input.goldenIssues]
    .map((issue) => [issue.id, issue.title])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const payload = JSON.stringify({
    model,
    issues,
    candidate: [input.candidate.file, input.candidate.line, input.candidate.text],
  });
  return createHash("sha256").update(payload).digest("hex");
}

export interface CachedFindingMatcherOptions {
  readonly inner: FindingMatcherPort;
  readonly dir: string;
  /** Part of the key: a decision by one model never replays for another. */
  readonly model: string;
}

interface CacheEntry {
  readonly issueId: string | null;
  readonly model: string;
}

let tmpCounter = 0;

export function createCachedFindingMatcher(
  options: CachedFindingMatcherOptions,
): FindingMatcherPort {
  return {
    async match(input: FindingMatchInput): Promise<FindingMatch> {
      const path = join(options.dir, `${matcherCacheKey(input, options.model)}.json`);
      try {
        const entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
        return { issueId: entry.issueId, costUsd: 0, cached: true };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const decision = await options.inner.match(input);
      await mkdir(options.dir, { recursive: true });
      const entry: CacheEntry = { issueId: decision.issueId, model: options.model };
      // Atomic: with concurrent cases two writers may hit the same key, and a
      // reader must never see a half-written file.
      const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
      await writeFile(tmp, `${JSON.stringify(entry)}\n`, "utf8");
      await rename(tmp, path);
      return decision;
    },
  };
}
