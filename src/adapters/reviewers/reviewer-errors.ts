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
