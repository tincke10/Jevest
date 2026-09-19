import { describe, expect, it } from "vitest";
import { containsSecret, redact } from "./redact.js";

describe("redact", () => {
  it("returns the text unchanged with zero redactions when there is nothing to redact", () => {
    const result = redact("const x = 1;\nfunction add(a, b) { return a + b; }");
    expect(result.redactions).toBe(0);
    expect(result.text).toBe("const x = 1;\nfunction add(a, b) { return a + b; }");
  });

  it("redacts a .env-style KEY=value assignment", () => {
    const result = redact('TYPESAFE_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"');
    expect(result.redactions).toBeGreaterThan(0);
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a JS/TS variable assignment named like a secret", () => {
    const result = redact('const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";');
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a password assignment", () => {
    const result = redact('password: "hunter2-super-secret-value"');
    expect(result.text).not.toContain("hunter2-super-secret-value");
  });

  it("redacts an AWS access key id", () => {
    const result = redact("aws_key = AKIAABCDEFGHIJKLMNOP");
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.text).toContain("[REDACTED]");
  });

  it("redacts a GitHub personal access token", () => {
    const result = redact("token: ghp_123456789012345678901234567890123456");
    expect(result.text).not.toContain("ghp_123456789012345678901234567890123456");
  });

  it("redacts a full PEM private key block", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----";
    const result = redact(`const cert = \`${key}\`;`);
    expect(result.text).not.toContain("MIIBOgIBAAJBAK");
    expect(result.text).toContain("[REDACTED]");
  });

  it("counts multiple distinct redactions", () => {
    const result = redact(
      'const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";\nconst password = "hunter2-super-secret";',
    );
    expect(result.redactions).toBe(2);
  });

  it("does not redact ordinary identifiers that merely contain 'key' as a substring, without a suspicious value", () => {
    const result = redact("const keyboardLayout = getLayout();");
    expect(result.redactions).toBe(0);
    expect(result.text).toBe("const keyboardLayout = getLayout();");
  });
});

describe("containsSecret", () => {
  it("is false for text with nothing to redact", () => {
    expect(containsSecret("const x = 1;")).toBe(false);
  });

  it("is true for text containing a secret", () => {
    expect(containsSecret('const apiKey = "sk-abcdefghijklmnopqrstuvwxyz";')).toBe(true);
  });
});
