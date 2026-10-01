/**
 * Hard exclusions for agentic findings (`reviewer.mode: agentic`): pure,
 * deterministic rules that drop a finding before any model judges it. The
 * industry reviewers this mode follows (one agent per PR, then per-finding
 * verification) all carry such a list; it removes whole classes of noise
 * no judge needs to spend a call on. Checked in order, first match wins:
 *
 * 1. `category` — not one of {@link AGENTIC_CATEGORIES}.
 * 2. `excluded-file` — the finding is located in a generated, lock,
 *    minified or markdown file.
 * 3. `excluded-claim` — the claim is about denial of service / rate
 *    limiting, asks for more logging, or is about style, naming,
 *    formatting or documentation.
 * 4. `no-evidence-in-changed-file` — no evidence item is in a file the PR
 *    changed. A cross-file finding (a caller broken by the change) is kept
 *    as long as it cites the changed code that causes it.
 *
 * Every drop carries a reason and a one-line detail for the comment's
 * details and the run's metrics.
 */
import { AGENTIC_CATEGORIES, type AgenticFinding } from "./agentic-finding.js";
import { evidencePathCandidates } from "./evidence-verifier.js";

export type ExclusionReason =
  | "category"
  | "excluded-file"
  | "excluded-claim"
  | "no-evidence-in-changed-file";

export interface Exclusion {
  readonly reason: ExclusionReason;
  readonly detail: string;
}

const LOCK_FILE_RE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|go\.sum|[^/]+\.lock)$/i;
const MINIFIED_RE = /\.min\.(?:js|mjs|cjs|css)$|\.map$/i;
const MARKDOWN_RE = /\.(?:md|mdx|markdown)$/i;
const GENERATED_RE =
  /(?:^|\/)(?:dist|build|generated|__generated__)\/|\.generated\.[^/]+$|\.pb\.go$|_pb2\.py$|\.g\.dart$/i;

/** True for a generated, lock, minified or markdown file. */
export function isExcludedFile(path: string): boolean {
  return (
    LOCK_FILE_RE.test(path) ||
    MINIFIED_RE.test(path) ||
    MARKDOWN_RE.test(path) ||
    GENERATED_RE.test(path)
  );
}

const EXCLUDED_CLAIM_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "denial of service", re: /\bdenial[- ]of[- ]service\b|\bDoS\b/ },
  { label: "rate limiting", re: /\brate[- ]?limit(?:s|ed|ing)?\b|\bthrottl(?:e|ing)\b/i },
  {
    label: "logging request",
    re: /\b(?:consider|should|could)\s+(?:add(?:ing)?|log(?:ging)?)\b[^.]*\blog(?:s|ging)?\b|\b(?:add|adding)\s+(?:more\s+|some\s+)?(?:logging|log statements)\b|\black of logging\b/i,
  },
  {
    label: "style",
    re: /\bnaming convention\b|\b(?:variable|function|method|class)\s+names?\b[^.]*\b(?:should|could|unclear|misleading|convention)\b|\bcode style\b|\bformatting\b|\bindentation\b|\bwhitespace\b|\breadability\b|\bstyle (?:issue|nit)\b|\bnit:/i,
  },
  {
    label: "documentation",
    re: /\bmissing (?:documentation|docs|docstrings?|comments?|jsdoc)\b|\bundocumented\b|\bdocstring\b/i,
  },
];

function changedFileSet(changedFiles: readonly string[]): Set<string> {
  return new Set(changedFiles.flatMap((path) => evidencePathCandidates(path)));
}

/** The first rule the finding breaks, or `null` when it is kept (see the module doc). */
export function exclusionFor(
  finding: AgenticFinding,
  changedFiles: readonly string[],
): Exclusion | null {
  if (!(AGENTIC_CATEGORIES as readonly string[]).includes(finding.category)) {
    return {
      reason: "category",
      detail: `category "${String(finding.category)}" is not reviewed (allowed: ${AGENTIC_CATEGORIES.join(", ")})`,
    };
  }
  if (isExcludedFile(finding.file)) {
    return {
      reason: "excluded-file",
      detail: `${finding.file} is a generated, lock, minified or markdown file`,
    };
  }
  const claimMatch = EXCLUDED_CLAIM_PATTERNS.find((pattern) => pattern.re.test(finding.claim));
  if (claimMatch !== undefined) {
    return {
      reason: "excluded-claim",
      detail: `the claim is about ${claimMatch.label}, which this review does not report`,
    };
  }
  const changed = changedFileSet(changedFiles);
  const citesChange = finding.evidence.some((item) =>
    evidencePathCandidates(item.file).some((path) => changed.has(path)),
  );
  if (!citesChange) {
    return {
      reason: "no-evidence-in-changed-file",
      detail: "no evidence item cites a file this pull request changed",
    };
  }
  return null;
}
