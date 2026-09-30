import { describe, expect, it } from "vitest";
import { describeReviewerError, isAuthenticationFailure } from "./reviewer-error.js";

const RAW_401 =
  'claude-cli process exited with code 1: result: Failed to authenticate. API Error: 401 OAuth access token is invalid. | stdout: {"type":"result","subtype":"success","is_error":true,"api_error_status":401,"duration_ms":1960} | stderr: boom';

describe("describeReviewerError", () => {
  it("keeps just the result text and drops the stdout/stderr dumps", () => {
    expect(describeReviewerError(RAW_401)).toBe(
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    );
  });

  it("gives the same text for messages that differ only in per-call values", () => {
    const other = RAW_401.replace("1960", "2210");
    expect(describeReviewerError(other)).toBe(describeReviewerError(RAW_401));
  });

  it("drops a raw stdout envelope when there is no result part", () => {
    expect(
      describeReviewerError(
        'claude-cli process exited with code 2: stdout: {"duration_ms":5} | stderr: nope',
      ),
    ).toBe("claude-cli process exited with code 2:");
  });

  it("drops the envelope excerpt of a claude-cli error", () => {
    expect(
      describeReviewerError(
        'claude-cli reviewer error: is_error (subtype=success, api_error_status=500): {"duration_ms":9}',
      ),
    ).toBe("claude-cli reviewer error: is_error (subtype=success, api_error_status=500)");
  });

  it("collapses whitespace, swaps backticks and caps the length", () => {
    expect(describeReviewerError("a\n  `b`\tc")).toBe("a 'b' c");
    const long = describeReviewerError("x".repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("leaves a plain short message alone", () => {
    expect(describeReviewerError("anthropic reviewer rate-limited (429); back off and retry")).toBe(
      "anthropic reviewer rate-limited (429); back off and retry",
    );
  });
});

describe("isAuthenticationFailure", () => {
  it.each([
    "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    "openai reviewer authentication failed (401); check the API key",
    "401 invalid x-api-key",
    "API Error: 403 forbidden: authentication error",
  ])("recognizes %s", (m) => {
    expect(isAuthenticationFailure(m)).toBe(true);
  });

  it.each([
    "anthropic reviewer rate-limited (429); back off and retry",
    "claude-cli reviewer timed out after 1401ms",
  ])("ignores %s", (m) => {
    expect(isAuthenticationFailure(m)).toBe(false);
  });
});
