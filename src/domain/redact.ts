/**
 * Mandatory redactor before any external adapter call (NFR-3): strips API
 * keys, tokens, passwords, private keys, and `.env`-style secret
 * assignments, replacing them with `[REDACTED]`. Not a general-purpose
 * secrets scanner — a practical, high-signal set of patterns for the
 * common cases NFR-3 names explicitly.
 */

export interface RedactResult {
  readonly text: string;
  readonly redactions: number;
}

/**
 * Any `identifier = value` / `identifier: "value"` style assignment.
 * Whether `identifier` actually *looks* secret-flavored (contains a whole
 * word like "key" or "password", not just a substring — so "keyboard"
 * doesn't match "key") is decided separately by {@link isSecretLikeName},
 * since that word-boundary logic is awkward to express correctly in a
 * single regex (a naive `key|token|...` alternation inside a bigger
 * identifier pattern either misses whole-word identifiers like `password`
 * or false-positives on words like `keyboard` depending on how the
 * mandatory prefix is written).
 */
const ASSIGNMENT_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(["'`]?)([^\s"'`;,\n]+)\2/g;

const SECRET_WORDS = new Set(["key", "token", "secret", "password", "passwd", "pwd"]);

/** True when `identifier`, split into words (snake_case and camelCase boundaries), contains a secret-flavored whole word. */
function isSecretLikeName(identifier: string): boolean {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
  return words.some((word) => SECRET_WORDS.has(word));
}

/** Well-known prefixed token formats: OpenAI/Anthropic-style, GitHub PAT, Slack, AWS access key id. */
const KNOWN_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** A full PEM private key block, redacted as a whole. */
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const REDACTED = "[REDACTED]";

/**
 * Replaces secrets with `[REDACTED]` and reports how many were found.
 * Order matters: private key blocks and known-prefixed tokens are matched
 * first (whole-match replacement), then generic key/token/secret/password
 * assignments (value-only replacement) over what's left.
 */
export function redact(text: string): RedactResult {
  let redactions = 0;
  let result = text;

  result = result.replace(PRIVATE_KEY_BLOCK_RE, () => {
    redactions++;
    return REDACTED;
  });

  for (const pattern of KNOWN_TOKEN_PATTERNS) {
    result = result.replace(pattern, () => {
      redactions++;
      return REDACTED;
    });
  }

  result = result.replace(ASSIGNMENT_RE, (match, name: string, quote: string, value: string) => {
    if (!isSecretLikeName(name) || value === REDACTED) {
      // Either not a secret-flavored name, or already redacted by an
      // earlier pass (a known-token pattern matched this exact value) —
      // don't count or rewrite it a second time.
      return match;
    }
    redactions++;
    return `${name}=${quote}${REDACTED}${quote}`;
  });

  return { text: result, redactions };
}

export function containsSecret(text: string): boolean {
  return redact(text).redactions > 0;
}
