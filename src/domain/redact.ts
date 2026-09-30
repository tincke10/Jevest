/**
 * Mandatory redactor before any external adapter call (NFR-3): strips API
 * keys, tokens, passwords, private keys, and `.env`-style secret
 * assignments, replacing them with `[REDACTED]`. Not a general-purpose
 * secrets scanner — a practical, high-signal set of patterns for the
 * common cases NFR-3 names explicitly.
 *
 * Three passes, in order:
 *
 * 1. PEM private key blocks, redacted whole (one `[REDACTED]` per line, so
 *    a redacted diff keeps its line count).
 * 2. Well-known token formats ({@link KNOWN_TOKEN_PATTERNS}), redacted
 *    wherever they appear, whatever the surrounding name.
 * 3. Named assignments (`name = value`, `name: value`, `'name' => value`),
 *    where the NAME contains a whole secret word (key, token, secret,
 *    password, passwd, pwd) AND the VALUE looks like a literal credential.
 *    Measured on real PRs, a name-only rule flagged cache keys, CSRF
 *    lookups, `key === prev` comparisons and `'key' => 'EUR'` maps, and
 *    every one of them hid a hunk from the reviewer. So the value decides:
 *
 *    - Never a secret: a comparison (`==`, `===`, `!=`, `!==`, `>=`, `<=`)
 *      or an arrow (`=>` after an unquoted name); an unquoted value (code:
 *      `$var`, a call, `++run`, `this.x`, `props.token`, a bare identifier)
 *      except on an `.env` line (`UPPER_SNAKE=value` at the start of a
 *      line, optionally after a diff marker and `export`); a quoted value
 *      with interpolation (`${…}`, `{$…}`, `#{…}`) or concatenated (`.`/`+`
 *      after the closing quote); a value with whitespace (a label, a
 *      sentence); a value that ends with `:` or starts with a `prefix:`
 *      (cache-key or URL shape); a validation-rule list
 *      (`required|min:8`); a placeholder (example, sample, dummy, fake,
 *      test, changeme, placeholder, your, xxx, `***`, `<…>`, session-token,
 *      redacted, todo, or one repeated character); a value containing the
 *      name's own secret word (`'password_confirmation'`).
 *    - password / passwd / pwd / secret names: a literal of length ≥ 8.
 *    - key / token names: a literal of length ≥ 16 that is not a word
 *      slug (letters-only words joined by `_ - . :`, each at most 20
 *      letters plus up to two digits, like `acme_tracing_id`), with
 *      Shannon entropy ≥ 3.0 bits/char or letters and digits and length
 *      ≥ 20.
 *
 *    Key-like words qualified as a non-secret never make a name secret:
 *    cacheKey, sortKey, primaryKey, foreignKey, keyPrefix, i18nKey,
 *    translationKey, titleKey, routeKey, storageKey, idempotencyKey,
 *    csrfToken, tokenType (any casing: `CACHE_KEY`, `cache_key`). Words
 *    like keyboard, keyof and tokenizer are not whole secret words.
 *    Only the value is replaced; the name and operator stay as written.
 */

export interface RedactResult {
  readonly text: string;
  readonly redactions: number;
}

const REDACTED = "[REDACTED]";

interface KnownTokenPattern {
  readonly pattern: RegExp;
  /** Replacement text; `$1` keeps a captured prefix (the `Bearer ` scheme). */
  readonly replacement: string;
}

/**
 * Well-known token formats, redacted wherever they appear: OpenAI-style
 * `sk-`, Anthropic `sk-ant-` and OpenAI `sk-proj-`, Stripe live secret and
 * restricted keys, GitHub tokens, Slack tokens, AWS access key ids, Google
 * API keys, JWTs, and a long `Bearer` token (with at least one digit, so
 * `Bearer someVariableName` in prose is left alone). Order matters: the
 * prefixed `sk-…-` forms before the plain `sk-`, JWT before Bearer.
 */
const KNOWN_TOKEN_PATTERNS: readonly KnownTokenPattern[] = [
  { pattern: /\bsk-(?:ant|proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9]{16,}\b/g, replacement: REDACTED },
  { pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g, replacement: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: REDACTED },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: REDACTED,
  },
  {
    pattern: /\b(Bearer[ \t]+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{20,}=*/g,
    replacement: `$1${REDACTED}`,
  },
];

/** A full PEM private key block, redacted as a whole. */
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * A PEM block becomes one `[REDACTED]` per line, keeping each continuation
 * line's diff marker (`+`, `-`, space), so a redacted hunk keeps its line
 * count and the reviewer's line numbers still map onto the real file. A
 * line starting with six dashes is a removed `-----BEGIN/END` line; five
 * dashes is the header itself.
 */
function redactPemBlock(block: string): string {
  return block
    .split("\n")
    .map((line, i) => {
      if (i === 0) return REDACTED;
      const marker = /^(?:------|[+ ]|-(?!----))/.test(line) ? line[0] : "";
      return `${marker}${REDACTED}`;
    })
    .join("\n");
}

/**
 * A name (optionally quoted, as a JSON/PHP array key) followed by an
 * operator. Comparisons and arrows are captured so they can be rejected
 * explicitly rather than half-matched (`key === prev` must never read as
 * `key =` followed by `== prev`). A `:` followed by another `:` is a scope
 * operator (`Http::recorded`), not an assignment.
 */
const NAMED_OPERATOR_RE =
  /(?<![\w])(["']?)([A-Za-z_][A-Za-z0-9_]*)\1\s*(===|!==|==|!=|=>|>=|<=|:=|=|:(?!:))/g;

const COMPARISONS = new Set(["===", "!==", "==", "!=", ">=", "<="]);

type SecretKind = "password" | "key";

const PASSWORD_WORDS = new Set(["secret", "password", "passwd", "pwd"]);
const KEY_WORDS = new Set(["key", "token"]);

/** Adjacent word pairs that qualify a key-like word as a non-secret (see the module doc). */
const NON_SECRET_PAIRS = new Set([
  "cache key",
  "sort key",
  "primary key",
  "foreign key",
  "key prefix",
  "i18n key",
  "translation key",
  "title key",
  "route key",
  "storage key",
  "idempotency key",
  "csrf token",
  "token type",
]);

function nameWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_-]+/)
    .filter(Boolean);
}

/**
 * The secret kind of a name, or `null` when it is not secret-flavored:
 * `password` when a password/secret word appears, `key` when only an
 * unqualified key/token word does.
 */
function secretKindOf(words: readonly string[]): SecretKind | null {
  if (words.some((w) => PASSWORD_WORDS.has(w))) return "password";
  const unqualifiedKeyWord = words.some((word, i) => {
    if (!KEY_WORDS.has(word)) return false;
    const before = i > 0 ? `${words[i - 1]} ${word}` : "";
    const after = i < words.length - 1 ? `${word} ${words[i + 1]}` : "";
    return !NON_SECRET_PAIRS.has(before) && !NON_SECRET_PAIRS.has(after);
  });
  return unqualifiedKeyWord ? "key" : null;
}

/** Shannon entropy of `text` in bits per character; 0 for an empty string. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER_RE =
  /example|sample|dummy|fake|test|changeme|placeholder|your|xxx|\*\*\*|<[^>]*>|session-token|redacted|todo/i;
const INTERPOLATION_RE = /\$\{|\{\$|#\{/;
const PREFIX_SHAPE_RE = /^[A-Za-z][\w.-]*:/;
const VALIDATION_RULES_RE = /^[a-z_]+(?::[^|]*)?(?:\|[a-z_]+(?::[^|]*)?)+$/;
const WORDY_SEGMENT_RE = /^(?:[A-Za-z]{1,20}\d{0,2}|\d{1,4})$/;

function isWordSlug(value: string): boolean {
  return value.split(/[_.:-]+/).every((segment) => WORDY_SEGMENT_RE.test(segment));
}

/** Whether a literal value (quotes stripped) looks like a credential for a name of `kind`. */
function looksLikeCredential(value: string, kind: SecretKind, words: readonly string[]): boolean {
  if (value.length === 0 || /\s/.test(value)) return false;
  if (INTERPOLATION_RE.test(value)) return false;
  if (value.endsWith(":") || PREFIX_SHAPE_RE.test(value)) return false;
  if (VALIDATION_RULES_RE.test(value)) return false;
  if (PLACEHOLDER_RE.test(value) || /^(.)\1*$/.test(value)) return false;
  const lower = value.toLowerCase();
  if (words.some((w) => w.length >= 5 && lower.includes(w))) return false;
  if (kind === "password") return value.length >= 8;
  if (value.length < 16 || isWordSlug(value)) return false;
  const lettersAndDigits = /[A-Za-z]/.test(value) && /\d/.test(value);
  return shannonEntropy(value) >= 3.0 || (lettersAndDigits && value.length >= 20);
}

/** The value right after an operator: a quoted literal, or an unquoted run. */
interface ParsedValue {
  /** Start and end (exclusive) of the part to replace, within the line. */
  readonly start: number;
  readonly end: number;
  readonly content: string;
  readonly quoted: boolean;
  /** Code continues right after the closing quote (`'a' . $id`, `'a' + b`). */
  readonly concatenated: boolean;
}

function parseValue(line: string, from: number): ParsedValue | null {
  let i = from;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  const quote = line[i];
  if (quote === '"' || quote === "'" || quote === "`") {
    let j = i + 1;
    while (j < line.length && line[j] !== quote) {
      j += line[j] === "\\" ? 2 : 1;
    }
    if (j >= line.length) return null;
    const rest = line.slice(j + 1);
    return {
      start: i + 1,
      end: j,
      content: line.slice(i + 1, j),
      quoted: true,
      concatenated: /^\s*[.+]/.test(rest),
    };
  }
  const match = /^[^\s;,#]+/.exec(line.slice(i));
  if (!match) return null;
  return {
    start: i,
    end: i + match[0].length,
    content: match[0],
    quoted: false,
    concatenated: false,
  };
}

const ENV_LINE_PREFIX_RE = /^[+\- ]?\s*(?:export\s+)?$/;

interface Replacement {
  readonly start: number;
  readonly end: number;
}

/** Value spans on one line that are named-assignment secrets. */
function namedSecretSpans(line: string): Replacement[] {
  const spans: Replacement[] = [];
  NAMED_OPERATOR_RE.lastIndex = 0;
  for (
    let match = NAMED_OPERATOR_RE.exec(line);
    match !== null;
    match = NAMED_OPERATOR_RE.exec(line)
  ) {
    const [whole, nameQuote, name, operator] = match as unknown as [string, string, string, string];
    if (COMPARISONS.has(operator)) continue;
    if (operator === "=>" && nameQuote === "") continue;
    const words = nameWords(name);
    const kind = secretKindOf(words);
    if (kind === null) continue;
    const value = parseValue(line, match.index + whole.length);
    if (value === null || value.concatenated) continue;
    if (!value.quoted) {
      const isEnvLine =
        operator === "=" &&
        nameQuote === "" &&
        /^[A-Z][A-Z0-9_]*$/.test(name) &&
        ENV_LINE_PREFIX_RE.test(line.slice(0, match.index)) &&
        !value.content.startsWith("$");
      if (!isEnvLine) continue;
    }
    if (!looksLikeCredential(value.content, kind, words)) continue;
    spans.push({ start: value.start, end: value.end });
    NAMED_OPERATOR_RE.lastIndex = value.end;
  }
  return spans;
}

function redactNamedAssignments(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const lines = text.split("\n").map((line) => {
    const spans = namedSecretSpans(line);
    if (spans.length === 0) return line;
    redactions += spans.length;
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      out += line.slice(cursor, span.start) + REDACTED;
      cursor = span.end;
    }
    return out + line.slice(cursor);
  });
  return { text: lines.join("\n"), redactions };
}

/**
 * Replaces secrets with `[REDACTED]` and reports how many were found.
 * Order matters: private key blocks and known-format tokens are matched
 * first (whole-match replacement), then named assignments (value-only
 * replacement) over what's left; a value an earlier pass already turned
 * into `[REDACTED]` is a placeholder to the last pass and never counts
 * twice.
 */
export function redact(text: string): RedactResult {
  let redactions = 0;
  let result = text.replace(PRIVATE_KEY_BLOCK_RE, (block) => {
    redactions++;
    return redactPemBlock(block);
  });

  for (const { pattern, replacement } of KNOWN_TOKEN_PATTERNS) {
    result = result.replace(pattern, (...args: unknown[]) => {
      redactions++;
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return replacement.replace("$1", prefix);
    });
  }

  const named = redactNamedAssignments(result);
  return { text: named.text, redactions: redactions + named.redactions };
}

export function containsSecret(text: string): boolean {
  return redact(text).redactions > 0;
}
