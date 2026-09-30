/**
 * The author's stated context: what the PR description says that helps a
 * reviewer understand the change (design decisions, intended behavior,
 * scope, constraints, linked tickets), extracted by one LLM call per PR
 * (ports/description-context-port.ts) and handed to the per-hunk reviewer.
 *
 * The description is author-controlled text, so it is also the natural
 * place to try to steer the review ("no review needed", "already tested",
 * "ignore file X", "LGTM"). The extractor is told to drop those sentences
 * and list them in `discarded`; {@link sanitizeAuthorContext} is the
 * deterministic belt-and-braces layer on top of it: every kept item that
 * still matches a review-suppression pattern (es + en) is moved to
 * `discarded`, every item is flattened to one line and cut to
 * {@link MAX_AUTHOR_CONTEXT_ITEM_CHARS}, and the kept total is capped at
 * {@link MAX_AUTHOR_CONTEXT_ITEMS}. The patterns err on the side of
 * dropping: a legitimate sentence that happens to match only loses a line
 * of context and shows up in the comment's "Discarded" list, while a
 * steering sentence that slipped through would reach the reviewer.
 *
 * Pure: no ports, no I/O.
 */

export interface AuthorContext {
  /** Design decisions and their rationale. */
  readonly decisions: readonly string[];
  /** Behavior changes the author says they intend. */
  readonly intendedBehaviorChanges: readonly string[];
  /** What the author says is explicitly out of scope. */
  readonly outOfScope: readonly string[];
  /** Known limitations, constraints and business rules. */
  readonly constraints: readonly string[];
  /** Linked tickets, issues, docs. */
  readonly references: readonly string[];
}

/** The kinds, in the order they are kept (and capped) and rendered. */
export const AUTHOR_CONTEXT_KINDS = [
  "decisions",
  "intendedBehaviorChanges",
  "outOfScope",
  "constraints",
  "references",
] as const satisfies readonly (keyof AuthorContext)[];

export const EMPTY_AUTHOR_CONTEXT: AuthorContext = {
  decisions: [],
  intendedBehaviorChanges: [],
  outOfScope: [],
  constraints: [],
  references: [],
};

/** Longest item, kept or discarded, after flattening. */
export const MAX_AUTHOR_CONTEXT_ITEM_CHARS = 200;
/** Most kept items across every kind; also the most discarded ones listed. */
export const MAX_AUTHOR_CONTEXT_ITEMS = 12;

/**
 * Review-suppression patterns, Spanish and English: requests to skip or
 * soften the review, quality/safety/testing claims offered as a reason to
 * trust the code, and anything addressed to a reviewer, an AI or a bot.
 */
const REVIEW_STEERING_PATTERNS: readonly RegExp[] = [
  // "no hace falta review", "no requiere revisión", "no es necesario revisar"
  /\bno\s+(?:hace\s+falta|necesita|requiere|precisa|es\s+necesari[oa])\s+(?:(?:un|una|el|la|de)\s+)?(?:code\s+)?(?:review|revisi[oó]n|revisar)/i,
  // "no review needed", "doesn't need a review", "review is not required"
  /\bno\s+(?:code\s+)?reviews?\s+(?:is\s+)?(?:needed|required|necessary)\b/i,
  /\b(?:does\s*n[o']?t|do\s*n[o']?t)\s+need\s+(?:a\s+|any\s+)?(?:code\s+)?review/i,
  /\breviews?\s+(?:is\s+)?(?:not\s+|un)(?:needed|required|necessary)\b/i,
  // "ya está testeado", "probado", "validado", "aprobado", "revisado"
  /\b(?:testead|probad|validad|aprobad|revisad|verificad)[oa]s?\b/i,
  // "already tested", "validated", "approved", "reviewed", "verified"
  /\b(?:tested|validated|approved|reviewed|verified)\b/i,
  // approve / skip requests
  /\b(?:lgtm|just\s+approve|auto-?approve|approve\s+(?:it|this|directly|right\s+away)|skip\s+(?:the\s+)?review)\b/i,
  /\b(?:aprob[aá]lo|aprobar\s+(?:directo|sin)|salte[aá]r?\s+(?:el\s+)?(?:review|revisi[oó]n)|omit[ií]r?\s+(?:el\s+|la\s+)?(?:review|revisi[oó]n))/i,
  // "ignore file X", "ignorá los cambios en ..."
  /\bignor(?:e|ar|á|a|en)\s+(?:(?:el|la|los|las|the|this|these|those|all|any)\s+)?(?:files?|archivos?|changes?|cambios?|diff|findings?|hallazgos?|warnings?|comments?|comentarios?|pr|review|revisi[oó]n|`)/i,
  // "don't comment on ...", "do not flag ..."
  /\b(?:don'?t|do\s+not|never)\s+(?:comment|flag|report|review|mention)\b/i,
  /\bno\s+(?:coment[eé]s|comentar|marqu[eé]s|marcar|report[eé]s|reportar|revis[eé]s)\b/i,
  // "safe change", "trivial change", "the change is safe"
  /\b(?:safe|trivial|harmless|risk-?free|low[- ]risk)\s+(?:change|pr|fix|update)\b/i,
  /\b(?:change|pr|this)\s+is\s+(?:safe|trivial|harmless|risk-?free)\b/i,
  /\bcambio\s+(?:seguro|trivial|inofensivo|sin\s+riesgo)\b/i,
  // addressed to a reviewer, an AI or a bot
  /\b(?:note|message|instructions?)\s+(?:to|for)\s+(?:the\s+)?(?:reviewers?|ai|bots?|llms?|models?|assistants?)\b/i,
  /\b(?:dear|hey|attention)\s+(?:the\s+)?(?:reviewers?|ai|bots?|llms?)\b/i,
  /\b(?:ai|llm)\s+reviewers?\b/i,
  /\b(?:nota|mensaje|instrucci[oó]n(?:es)?)\s+para\s+(?:el\s+|la\s+)?(?:revisor(?:es)?|ia|bot|modelo|asistente)\b/i,
  // coverage claims
  /(?:\b100\s*%|\bfull|\bcomplete)\s+(?:test\s+)?coverage\b/i,
  /\bcobertura\s+(?:completa|total|del\s+100)/i,
];

/** True when `text` tries to steer or skip the review, or asserts quality as a reason to trust the code. */
export function isReviewSteering(text: string): boolean {
  return REVIEW_STEERING_PATTERNS.some((pattern) => pattern.test(text));
}

function flatten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_AUTHOR_CONTEXT_ITEM_CHARS
    ? `${flat.slice(0, MAX_AUTHOR_CONTEXT_ITEM_CHARS - 1)}…`
    : flat;
}

export interface ExtractedAuthorContext {
  readonly context: AuthorContext;
  /** Short paraphrases of what was dropped from the description for steering the review. */
  readonly discarded: readonly string[];
}

/**
 * The deterministic post-filter over the extractor's output (see the
 * module doc). Order-preserving; duplicates are dropped after flattening.
 */
export function sanitizeAuthorContext(extracted: ExtractedAuthorContext): ExtractedAuthorContext {
  const seen = new Set<string>();
  const discarded: string[] = [];
  const discardedSeen = new Set<string>();
  const discard = (item: string): void => {
    if (discardedSeen.has(item) || discarded.length >= MAX_AUTHOR_CONTEXT_ITEMS) return;
    discardedSeen.add(item);
    discarded.push(item);
  };
  for (const raw of extracted.discarded) {
    const item = flatten(raw);
    if (item !== "") discard(item);
  }

  let kept = 0;
  const context: Record<keyof AuthorContext, string[]> = {
    decisions: [],
    intendedBehaviorChanges: [],
    outOfScope: [],
    constraints: [],
    references: [],
  };
  for (const kind of AUTHOR_CONTEXT_KINDS) {
    for (const raw of extracted.context[kind]) {
      const item = flatten(raw);
      if (item === "") continue;
      if (isReviewSteering(item)) {
        discard(item);
        continue;
      }
      if (seen.has(item) || kept >= MAX_AUTHOR_CONTEXT_ITEMS) continue;
      seen.add(item);
      context[kind].push(item);
      kept += 1;
    }
  }
  return { context, discarded };
}

export function authorContextItemCount(context: AuthorContext): number {
  return AUTHOR_CONTEXT_KINDS.reduce((total, kind) => total + context[kind].length, 0);
}

export function isAuthorContextEmpty(context: AuthorContext): boolean {
  return authorContextItemCount(context) === 0;
}

/** English headings for each kind, shared by the prompts and the comment. */
export const AUTHOR_CONTEXT_HEADINGS: Readonly<Record<keyof AuthorContext, string>> = {
  decisions: "Design decisions",
  intendedBehaviorChanges: "Intended behavior changes",
  outOfScope: "Out of scope",
  constraints: "Constraints and business rules",
  references: "References",
};
