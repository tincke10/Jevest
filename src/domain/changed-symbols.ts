/**
 * Changed-symbol extraction for the reviewer's impact context
 * (`reviewer.impactContext`, ../application/pipeline/stages/code-context.ts).
 * Pure: per-language regexes over a hunk's changed lines (`+`/`-`, never
 * context lines) and the enclosing definition git prints in the hunk
 * header (`@@ -a,b +c,d @@ function foo(`).
 *
 * What counts as a symbol: definitions (function / method / class / const /
 * interface / type / enum, PHP `function x`, Python `def`, Go `func`, Ruby
 * `def`), strings that name things other code looks up (route names
 * `route('x')` / `->name('x')`, config keys `config('a.b')`, cache keys,
 * Vue emits, test ids), Vue props, lower down member / static calls
 * (`->method(`, `::method(`, `.method(`) and object / array keys, and last
 * any other compound identifier a changed line references (camelCase,
 * snake_case, UPPER_SNAKE: `reduce(sumWithTax, 0)` changes what
 * `sumWithTax` is used for). Plain lowercase words never come from that
 * last class: they are local variables or prose.
 *
 * Measured on a real PR set (smoke run, 2026-10-01): plain lowercase calls
 * and keys (`.equal(`, `->header(`, `status:`) matched hundreds of lines
 * each and Playwright's `page.route('**\/x/**')` read as a route name. So a
 * plain lowercase name from the call / key class needs
 * {@link MIN_PLAIN_REFERENCE_LENGTH} characters (`disambiguate` stays,
 * `status` goes), and a lookup string with `*`, `/` or whitespace is not a
 * name.
 *
 * Noise is cut three ways: names of 3 characters or fewer, the
 * {@link SYMBOL_STOPLIST} (language keywords and very common names), and a
 * cap ({@link MAX_SYMBOLS_PER_HUNK}) applied after ranking definitions
 * first, then lookup strings, then calls and keys — so the cap drops the
 * least specific names. Prose files (Markdown, plain text) yield nothing.
 */

/** Default cap on symbols per hunk; each one is one search term. */
export const MAX_SYMBOLS_PER_HUNK = 12;

/** Shorter names match far too much code to be worth a search. */
const MIN_SYMBOL_LENGTH = 4;

/** A plain lowercase call or key (`.status(`, `body:`) shorter than this is a common word, not a name. */
export const MIN_PLAIN_REFERENCE_LENGTH = 8;

/**
 * Language keywords, framework verbs and very common names: searching any
 * of them returns half the repository. Compared case-sensitively against
 * the exact symbol (so `getUser` is never caught by `get`).
 */
export const SYMBOL_STOPLIST: ReadonlySet<string> = new Set([
  // the names the brief calls out
  "get",
  "set",
  "data",
  "value",
  "values",
  "id",
  "name",
  "type",
  "item",
  "items",
  "key",
  "keys",
  "index",
  "map",
  "filter",
  "then",
  "push",
  "length",
  // keywords (JS/TS, PHP, Python, Go, Ruby)
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "elif",
  "else",
  "elseif",
  "elsif",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "foreach",
  "from",
  "func",
  "function",
  "implements",
  "import",
  "instanceof",
  "interface",
  "isset",
  "lambda",
  "module",
  "namespace",
  "null",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "typeof",
  "undefined",
  "unless",
  "unset",
  "until",
  "void",
  "while",
  "with",
  "yield",
  // very common names and framework verbs
  "args",
  "apply",
  "array",
  "assign",
  "bind",
  "boolean",
  "call",
  "config",
  "concat",
  "context",
  "count",
  "create",
  "debug",
  "done",
  "each",
  "emit",
  "empty",
  "entries",
  "error",
  "event",
  "every",
  "find",
  "first",
  "forEach",
  "forget",
  "handle",
  "includes",
  "indexOf",
  "info",
  "init",
  "join",
  "json",
  "keyBy",
  "last",
  "list",
  "next",
  "number",
  "object",
  "options",
  "params",
  "parse",
  "pluck",
  "props",
  "push",
  "query",
  "reduce",
  "reject",
  "remember",
  "render",
  "replace",
  "request",
  "resolve",
  "response",
  "result",
  "route",
  "save",
  "send",
  "setup",
  "slice",
  "some",
  "sort",
  "split",
  "state",
  "string",
  "stringify",
  "test",
  "toArray",
  "toString",
  "trim",
  "update",
  "warn",
  "where",
]);

/** Prose files: changed lines are text, not code. */
const PROSE_EXTENSIONS = new Set(["md", "mdx", "markdown", "txt", "rst", "adoc"]);

const IDENT = "[A-Za-z_$][\\w$]*";

/** Definitions: function / class / const / method names, per language. */
const DEFINITION_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\bfunction\\s*&?\\s*(${IDENT})`, "g"),
  new RegExp(`\\b(?:class|interface|trait|enum)\\s+(${IDENT})`, "g"),
  new RegExp(`\\btype\\s+(${IDENT})\\s*(?:=|<|struct\\b|interface\\b)`, "g"),
  new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=`, "g"),
  // Python `def`, Ruby `def` / `def self.x` (with ? or !), Go `func (r *T) Name(`
  /\bdef\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/g,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\bmodule\s+([A-Z]\w*)/g,
  // a method definition: `name(args) {` with optional modifiers and return type
  new RegExp(
    `^\\s*(?:(?:public|private|protected|static|async|get|set|override|readonly|abstract|final)\\s+)*(${IDENT})\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{`,
    "g",
  ),
];

/** Strings other code looks up by value: routes, config / cache keys, emits, test ids. */
const STRING_PATTERNS: readonly RegExp[] = [
  /\broute\(\s*['"]([^'"]+)['"]/g,
  /->name\(\s*['"]([^'"]+)['"]/g,
  /\bconfig\(\s*['"]([^'"]+)['"]/g,
  /\bCache::\w+\(\s*['"]([^'"]+)['"]/g,
  /\bcache\(\)->\w+\(\s*['"]([^'"]+)['"]/g,
  /\$?\bemit\(\s*['"]([^'"]+)['"]/g,
  /\bdata-test(?:id|-id)?=["']([^"']+)["']/g,
  /\bgetByTestId\(\s*['"]([^'"]+)['"]/g,
];

/** Lists of quoted names: `defineEmits(['a', 'b'])`, `defineProps(['a'])`. */
const QUOTED_LIST_PATTERNS: readonly RegExp[] = [
  /\bdefineEmits\(\s*\[([^\]]*)\]/g,
  /\bdefineProps\(\s*\[([^\]]*)\]/g,
];

/** Object literals whose keys are definitions: `defineProps({ a: String })`, `defineProps<{ a: string }>()`. */
const KEYED_OBJECT_PATTERNS: readonly RegExp[] = [
  /\bdefineProps\(\s*\{([^}]*)\}/g,
  /\bdefineProps<\s*\{([^}]*)\}/g,
];

/** Calls and keys: the least specific names, ranked last. */
const REFERENCE_PATTERNS: readonly RegExp[] = [
  /->(\w+)\s*\(/g,
  /::(\w+)\s*\(/g,
  new RegExp(`\\.(${IDENT})\\s*\\(`, "g"),
  new RegExp(`^\\s*(${IDENT})\\s*:(?!:)`, "g"),
  /^\s*['"]([\w.-]+)['"]\s*=>/g,
];

const IDENTIFIER_RE = /[A-Za-z_]\w*/g;

/** camelCase, PascalCase with an inner capital, snake_case or UPPER_SNAKE: a name, not a word. */
function isCompoundIdentifier(name: string): boolean {
  return /[a-z0-9][A-Z]/.test(name) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(name);
}

const QUOTED_RE = /['"]([^'"]+)['"]/g;
const OBJECT_KEY_RE = new RegExp(`(${IDENT})\\??\\s*:`, "g");

/** Interpolated strings are cut at the interpolation: `products:{$id}` searches `products:`. */
function stringSymbol(raw: string): string | null {
  const cut = raw.split(/\$\{|\{\$|\{|\$/)[0] ?? "";
  if (/[\s*/]/.test(cut)) return null;
  return cut;
}

function changedLines(diff: string): string[] {
  const lines: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("\\")) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const marker = line.charAt(0);
    if (marker === "+" || marker === "-") lines.push(line.slice(1));
  }
  return lines;
}

/** The text after the second `@@` of a hunk header: git's enclosing-definition hint. */
function headerContext(hunkHeader: string): string {
  const match = /^@@[^@]*@@(.*)$/.exec(hunkHeader);
  return (match?.[1] ?? "").trim();
}

function collect(patterns: readonly RegExp[], text: string, into: string[]): void {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) into.push(name);
    }
  }
}

function collectStrings(text: string, into: string[]): void {
  for (const pattern of STRING_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const symbol = match[1] === undefined ? null : stringSymbol(match[1]);
      if (symbol !== null) into.push(symbol);
    }
  }
  for (const pattern of QUOTED_LIST_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      for (const quoted of (match[1] ?? "").matchAll(QUOTED_RE)) {
        const symbol = quoted[1] === undefined ? null : stringSymbol(quoted[1]);
        if (symbol !== null) into.push(symbol);
      }
    }
  }
}

function collectKeyedObjects(text: string, into: string[]): void {
  for (const pattern of KEYED_OBJECT_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      for (const key of (match[1] ?? "").matchAll(OBJECT_KEY_RE)) {
        if (key[1] !== undefined) into.push(key[1]);
      }
    }
  }
}

function isUseful(symbol: string): boolean {
  return (
    symbol.length >= MIN_SYMBOL_LENGTH && !SYMBOL_STOPLIST.has(symbol) && !/^\d+$/.test(symbol)
  );
}

export interface SymbolSourceHunk {
  readonly file: string;
  readonly hunkHeader: string;
  readonly diff: string;
}

/**
 * The symbols a hunk changes, most specific first, deduped and capped at
 * `max` (default {@link MAX_SYMBOLS_PER_HUNK}). See the module doc.
 */
export function extractChangedSymbols(
  hunk: SymbolSourceHunk,
  max: number = MAX_SYMBOLS_PER_HUNK,
): string[] {
  const ext = hunk.file.toLowerCase().split(".").pop() ?? "";
  if (PROSE_EXTENSIONS.has(ext)) return [];

  const header: string[] = [];
  const definitions: string[] = [];
  const strings: string[] = [];
  const references: string[] = [];
  const identifiers: string[] = [];

  collect(DEFINITION_PATTERNS, headerContext(hunk.hunkHeader), header);
  for (const line of changedLines(hunk.diff)) {
    collect(DEFINITION_PATTERNS, line, definitions);
    collectKeyedObjects(line, definitions);
    collectStrings(line, strings);
    const lineReferences: string[] = [];
    collect(REFERENCE_PATTERNS, line, lineReferences);
    references.push(
      ...lineReferences.filter(
        (name) => !/^[a-z]+$/.test(name) || name.length >= MIN_PLAIN_REFERENCE_LENGTH,
      ),
    );
    for (const match of line.matchAll(IDENTIFIER_RE)) {
      if (isCompoundIdentifier(match[0])) identifiers.push(match[0]);
    }
  }

  const ranked: string[] = [];
  const seen = new Set<string>();
  for (const symbol of [...header, ...definitions, ...strings, ...references, ...identifiers]) {
    if (seen.has(symbol) || !isUseful(symbol)) continue;
    seen.add(symbol);
    ranked.push(symbol);
    if (ranked.length >= max) break;
  }
  return ranked;
}
