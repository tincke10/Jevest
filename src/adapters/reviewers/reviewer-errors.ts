/**
 * Shared error taxonomy for reviewer adapters (SPEC NFR-1 in spirit — clear,
 * typed failures instead of string-matched messages). Both the Anthropic and
 * OpenAI adapters catch their SDK's typed exceptions most-specific first and
 * rethrow one of these, so `generate-findings.ts` can log a useful reason
 * without knowing which provider it's talking to.
 */

export class ReviewerRateLimitError extends Error {
  constructor(provider: string, cause: unknown) {
    super(`${provider} reviewer rate-limited (429); back off and retry`, { cause });
    this.name = "ReviewerRateLimitError";
  }
}

export class ReviewerAuthenticationError extends Error {
  constructor(provider: string, cause: unknown) {
    super(`${provider} reviewer authentication failed (401); check the API key`, { cause });
    this.name = "ReviewerAuthenticationError";
  }
}

export class ReviewerApiError extends Error {
  constructor(
    provider: string,
    status: number | undefined,
    type: string | null | undefined,
    cause: unknown,
  ) {
    super(
      `${provider} reviewer API error (status ${status ?? "unknown"}${type ? `, type ${type}` : ""})`,
      { cause },
    );
    this.name = "ReviewerApiError";
  }
}

export class ReviewerParseError extends Error {
  constructor(provider: string, hunkId: string) {
    super(`${provider} reviewer returned unparseable structured output for hunk "${hunkId}"`);
    this.name = "ReviewerParseError";
  }
}

/** The claude-cli process itself timed out and was killed (see claude-cli-reviewer.ts). */
export class ClaudeCliTimeoutError extends Error {
  constructor(timeoutMs: number, hunkId: string) {
    super(`claude-cli reviewer timed out after ${timeoutMs}ms for hunk "${hunkId}"`);
    this.name = "ClaudeCliTimeoutError";
  }
}

/** The claude-cli child process exited non-zero before producing any JSON envelope. */
export class ClaudeCliProcessError extends Error {
  constructor(exitCode: number | null, outputExcerpt: string) {
    super(`claude-cli process exited with code ${exitCode}: ${outputExcerpt}`);
    this.name = "ClaudeCliProcessError";
  }
}

/**
 * The claude-cli process produced a JSON envelope, but it reports failure
 * (invalid JSON, `is_error`, `subtype !== "success"`, missing/invalid
 * `structured_output`) for a reason other than rate limiting or usage-limit
 * quota (those throw {@link ReviewerRateLimitError} instead, so callers can
 * retry uniformly across providers).
 */
export class ClaudeCliError extends Error {
  constructor(
    reason: string,
    public readonly apiErrorStatus: unknown,
    public readonly subtype: unknown,
    outputExcerpt: string,
  ) {
    super(
      `claude-cli reviewer error: ${reason} (subtype=${String(subtype)}, api_error_status=${String(apiErrorStatus)}): ${outputExcerpt}`,
    );
    this.name = "ClaudeCliError";
  }
}
