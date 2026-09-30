/**
 * Human-readable reviewer/summarizer errors. Adapter messages (notably the
 * claude-cli ones) embed raw stdout JSON envelopes with per-call values such
 * as `duration_ms`, so identical failures never compare equal and flood the
 * comment. These pure helpers reduce a message to its human part; the raw
 * error is logged separately by the stages.
 */

/** Longest cleaned message. */
export const MAX_REVIEWER_ERROR_CHARS = 200;

const RESULT_PART = /(?:^|[\s:])result:\s*(.+?)(?:\s\|\s|$)/s;
const STDOUT_DUMP = /\s*\|?\s*stdout:.*$/s;
const ENVELOPE_EXCERPT = /(\))\s*:\s*[{[].*$/s;
const AUTH_FAILURE =
  /\b401\b|OAuth access token is invalid|Failed to authenticate|invalid x-api-key|authentication (?:failed|error)|\b403\b.*(?:auth|forbidden)/is;

export function describeReviewerError(message: string): string {
  const result = RESULT_PART.exec(message)?.[1];
  const human = result ?? message.replace(STDOUT_DUMP, "").replace(ENVELOPE_EXCERPT, "$1");
  const oneLine = human.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return oneLine.length > MAX_REVIEWER_ERROR_CHARS
    ? `${oneLine.slice(0, MAX_REVIEWER_ERROR_CHARS - 1)}…`
    : oneLine;
}

/** True when a (cleaned or raw) error message is an authentication/credential failure. */
export function isAuthenticationFailure(message: string): boolean {
  return AUTH_FAILURE.test(message);
}
