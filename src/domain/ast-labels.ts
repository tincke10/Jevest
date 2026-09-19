/**
 * Pure, deterministic ground-truth labeling of a hunk's surface (SPEC §4.2
 * H0', §5 Fase 0b), using the TypeScript compiler API to parse `before` and
 * `after` text as virtual source files.
 *
 * This lives in `domain/` because `ts.createSourceFile` is a pure,
 * in-memory text -> AST function with no I/O or network access — unlike
 * `@typesafe-ai/sdk`, it never touches an external system, so it doesn't
 * violate the "no SDK imports in domain" rule in spirit (no side effects,
 * fully deterministic, testable without any adapter).
 *
 * Hunks are fragments, not complete programs: `ts.createSourceFile` never
 * throws on malformed input (verified: unbalanced braces still parse to a
 * best-effort tree with parse diagnostics we simply ignore), so every
 * function here tolerates syntactically broken fragments by design.
 *
 * **Changed-lines-only rule** (all five labels, per
 * docs/analysis/h0-prime-error-analysis.md §1/§4): a hunk's `before` and
 * `after` text usually share unchanged context lines (the diff's
 * surrounding lines). Every label here is evaluated only against the
 * lines that actually differ between `before` and `after` — computed with
 * a standard LCS-based line diff (`changedLineSets`) — never against
 * unchanged context. This matches what the hunk's `raw-diff` serializer
 * shows Jev (marked `+`/`-` per line) and the question criteria's wording
 * ("add or change"), and avoids false positives from e.g. an untouched
 * `try`/`catch` sitting in a hunk's context lines.
 */
import ts from "typescript";

export type ChangeKind = "add-behavior" | "modify-behavior" | "delete" | "rename-or-format";

export interface AstProfileLabels {
  readonly changeKind: ChangeKind;
  readonly touchesPublicApi: boolean;
  readonly touchesErrorHandling: boolean;
  readonly touchesAsync: boolean;
  readonly touchesIo: boolean;
}

function parseFragment(text: string): ts.SourceFile {
  return ts.createSourceFile("fragment.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Depth-first walk over every descendant node, including `sourceFile` itself's children. */
function forEachDescendant(root: ts.Node, visit: (node: ts.Node) => void): void {
  function walk(node: ts.Node): void {
    visit(node);
    node.forEachChild(walk);
  }
  root.forEachChild(walk);
}

// ---------------------------------------------------------------------------
// Line diff: which line numbers (0-based) in `before`/`after` are part of
// the change, as opposed to shared, unchanged context. Standard LCS line
// matching — deterministic, no external dependency, fine at hunk scale
// (tens of lines).
// ---------------------------------------------------------------------------

interface ChangedLineSets {
  readonly beforeChanged: ReadonlySet<number>;
  readonly afterChanged: ReadonlySet<number>;
}

/**
 * Standard LCS length table over two line arrays, exposed as a lookup
 * function rather than a raw 2D array so callers never need a non-null
 * assertion: any (i, j) outside the table's bounds is mathematically 0
 * (the LCS of an empty suffix), which is also the correct fallback.
 */
function lcsLengths(a: readonly string[], b: readonly string[]): (i: number, j: number) => number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const match = a[i] === b[j];
      const diag = dp[i + 1]?.[j + 1] ?? 0;
      const down = dp[i + 1]?.[j] ?? 0;
      const right = dp[i]?.[j + 1] ?? 0;
      const row = dp[i];
      if (row) {
        row[j] = match ? diag + 1 : Math.max(down, right);
      }
    }
  }
  return (i, j) => dp[i]?.[j] ?? 0;
}

/** Lines present in `before` but not matched in `after` (and vice versa), by a simple LCS line diff. */
function changedLineSets(beforeText: string, afterText: string): ChangedLineSets {
  const a = beforeText.split("\n");
  const b = afterText.split("\n");
  const lcsAt = lcsLengths(a, b);

  const beforeChanged = new Set<number>();
  const afterChanged = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcsAt(i + 1, j) >= lcsAt(i, j + 1)) {
      beforeChanged.add(i);
      i++;
    } else {
      afterChanged.add(j);
      j++;
    }
  }
  while (i < a.length) {
    beforeChanged.add(i);
    i++;
  }
  while (j < b.length) {
    afterChanged.add(j);
    j++;
  }

  return { beforeChanged, afterChanged };
}

/** Whether any line `node` spans (inclusive) is in `changedLines`. */
function intersectsChangedLines(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  changedLines: ReadonlySet<number>,
): boolean {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  for (let line = startLine; line <= endLine; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

/** True if any descendant of `sourceFile` intersecting a changed line satisfies `matches`. */
function anyChangedNodeMatches(
  sourceFile: ts.SourceFile,
  changedLines: ReadonlySet<number>,
  matches: (node: ts.Node) => boolean,
): boolean {
  let found = false;
  forEachDescendant(sourceFile, (node) => {
    if (found) return;
    if (!intersectsChangedLines(sourceFile, node, changedLines)) return;
    if (matches(node)) found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// change_kind
// ---------------------------------------------------------------------------

/**
 * A structural fingerprint of the fragment: node kinds only, with
 * identifiers normalized (name text dropped) so a pure rename doesn't
 * change the signature, but literal values are kept (a changed literal —
 * including a regex literal's pattern and flags — is a real change, not a
 * rename).
 */
function structuralSignature(sourceFile: ts.SourceFile): string {
  const parts: string[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      parts.push("Identifier");
      return;
    }
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      parts.push(`${ts.SyntaxKind[node.kind]}:${node.text}`);
      return;
    }
    parts.push(ts.SyntaxKind[node.kind]);
  });
  return parts.join("|");
}

/**
 * Statements plus call expressions, restricted to nodes on a changed line:
 * a simple proxy for "how much behavior surface changed", ignoring
 * unchanged context that happens to appear in the fragment.
 */
function behaviorSurfaceCount(
  sourceFile: ts.SourceFile,
  changedLines: ReadonlySet<number>,
): number {
  let count = 0;
  forEachDescendant(sourceFile, (node) => {
    if (!intersectsChangedLines(sourceFile, node, changedLines)) return;
    if (ts.isStatement(node) || ts.isCallExpression(node)) {
      count++;
    }
  });
  return count;
}

/**
 * Rule (kept intentionally simple and deterministic):
 * 1. If the before/after structural signatures are identical (same AST
 *    shape modulo identifier names; literal values, including regex
 *    patterns/flags, are kept), it's a pure rename or formatting change:
 *    "rename-or-format".
 * 2. Otherwise, compare a behavior-surface count (statements + calls) on
 *    the changed lines only: more in `after` -> "add-behavior"; fewer ->
 *    "delete" (net removal); equal but structurally different ->
 *    "modify-behavior" (same shape of code, different content — e.g. a
 *    changed condition, operator, or regex).
 */
export function classifyChangeKind(before: string, after: string): ChangeKind {
  const beforeFile = parseFragment(before);
  const afterFile = parseFragment(after);

  if (structuralSignature(beforeFile) === structuralSignature(afterFile)) {
    return "rename-or-format";
  }

  const { beforeChanged, afterChanged } = changedLineSets(before, after);
  const beforeCount = behaviorSurfaceCount(beforeFile, beforeChanged);
  const afterCount = behaviorSurfaceCount(afterFile, afterChanged);

  if (afterCount > beforeCount) return "add-behavior";
  if (afterCount < beforeCount) return "delete";
  return "modify-behavior";
}

// ---------------------------------------------------------------------------
// touches_public_api
// ---------------------------------------------------------------------------

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

function isPrivateMember(member: ts.ClassElement): boolean {
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) return true;
  const name = (member as { name?: ts.PropertyName }).name;
  return name !== undefined && ts.isPrivateIdentifier(name);
}

/**
 * A normalized signature string per exported top-level declaration, keyed
 * by `(kind, name)` — not name alone — so declaration merging (e.g. an
 * exported `interface Foo` and an exported `const Foo`) can't collide and
 * silently hide one of the two changing. Only declarations whose text
 * intersects a changed line are included (SPEC NFR-14-adjacent: judge only
 * what actually changed).
 */
function exportedSignatures(
  sourceFile: ts.SourceFile,
  changedLines: ReadonlySet<number>,
): Map<string, string> {
  const signatures = new Map<string, string>();
  const set = (kind: string, name: string, signature: string) => {
    signatures.set(`${kind}:${name}`, signature);
  };

  for (const statement of sourceFile.statements) {
    if (!intersectsChangedLines(sourceFile, statement, changedLines)) continue;

    if (isExported(statement)) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const params = statement.parameters.map((p) => p.getText(sourceFile)).join(",");
        const returnType = statement.type?.getText(sourceFile) ?? "";
        set("function", statement.name.text, `function(${params}):${returnType}`);
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        const members = statement.members
          .filter((m) => !isPrivateMember(m))
          .map((m) => m.getText(sourceFile))
          .sort()
          .join(";");
        set("class", statement.name.text, `class{${members}}`);
      } else if (ts.isInterfaceDeclaration(statement)) {
        set("interface", statement.name.text, `interface:${statement.getText(sourceFile)}`);
      } else if (ts.isTypeAliasDeclaration(statement)) {
        set("type", statement.name.text, `type:${statement.getText(sourceFile)}`);
      } else if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const typeText = decl.type?.getText(sourceFile) ?? "";
            set("var", decl.name.text, `var:${typeText}`);
          }
        }
      }
    }

    if (ts.isExportDeclaration(statement)) {
      const moduleText = statement.moduleSpecifier?.getText(sourceFile) ?? "";
      if (!statement.exportClause) {
        // `export * from "mod";` — wildcard re-export, no per-name entries.
        set("export-star", moduleText, `export-star:${moduleText}`);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        // `export * as ns from "mod";`
        const ns = statement.exportClause.name.text;
        set("export-namespace", ns, `export-namespace:${moduleText}`);
      } else {
        // `export { a, b as c } from "mod";` or local `export { a, b };`
        for (const specifier of statement.exportClause.elements) {
          const exportedName = specifier.name.text;
          const localName = specifier.propertyName?.text ?? exportedName;
          set(
            "export-named",
            exportedName,
            moduleText
              ? `export-named-from:${moduleText}:${localName}`
              : `export-named-local:${localName}`,
          );
        }
      }
    }
  }

  return signatures;
}

/** True when the set of exported (kind, name) signatures differs between before and after. */
export function touchesPublicApi(before: string, after: string): boolean {
  const beforeFile = parseFragment(before);
  const afterFile = parseFragment(after);
  const { beforeChanged, afterChanged } = changedLineSets(before, after);

  const beforeSignatures = exportedSignatures(beforeFile, beforeChanged);
  const afterSignatures = exportedSignatures(afterFile, afterChanged);

  if (beforeSignatures.size !== afterSignatures.size) return true;

  for (const [key, signature] of beforeSignatures) {
    if (afterSignatures.get(key) !== signature) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// touches_error_handling / touches_async / touches_io
// ---------------------------------------------------------------------------

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

/** Identifier ends in "Error", case-sensitive (e.g. `ValidationError`, `handleError`) — not a case-insensitive substring like `console.error`. */
const ENDS_WITH_ERROR = /Error$/;

function isErrorHandlingNode(node: ts.Node): boolean {
  if (ts.isTryStatement(node) || ts.isThrowStatement(node) || ts.isCatchClause(node)) {
    return true;
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const name = calleeName(node.expression);
    return name !== null && ENDS_WITH_ERROR.test(name);
  }
  return false;
}

export function touchesErrorHandling(before: string, after: string): boolean {
  const beforeFile = parseFragment(before);
  const afterFile = parseFragment(after);
  const { beforeChanged, afterChanged } = changedLineSets(before, after);
  return (
    anyChangedNodeMatches(beforeFile, beforeChanged, isErrorHandlingNode) ||
    anyChangedNodeMatches(afterFile, afterChanged, isErrorHandlingNode)
  );
}

const ASYNC_CALL_NAMES = new Set(["setTimeout", "queueMicrotask", "then"]);

function isAsyncNode(node: ts.Node): boolean {
  if (ts.isAwaitExpression(node)) return true;
  // Check the modifier *token* itself (its own small span), not the
  // declaration it modifies (whose span covers the whole body) — otherwise
  // an `async` keyword on an unchanged line would look "changed" merely
  // because something elsewhere in the same function body changed.
  if (node.kind === ts.SyntaxKind.AsyncKeyword) return true;
  if (ts.isIdentifier(node) && node.text === "Promise") return true;
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    return name !== null && ASYNC_CALL_NAMES.has(name);
  }
  return false;
}

export function touchesAsync(before: string, after: string): boolean {
  const beforeFile = parseFragment(before);
  const afterFile = parseFragment(after);
  const { beforeChanged, afterChanged } = changedLineSets(before, after);
  return (
    anyChangedNodeMatches(beforeFile, beforeChanged, isAsyncNode) ||
    anyChangedNodeMatches(afterFile, afterChanged, isAsyncNode)
  );
}

const IO_IDENTIFIER_NAMES = new Set([
  "fs",
  "net",
  "process",
  "fetch",
  "http",
  "https",
  "stream",
  "Request",
  "Response",
  "readFile",
  "writeFile",
  "readFileSync",
  "writeFileSync",
]);

function isIoNode(node: ts.Node): boolean {
  return ts.isIdentifier(node) && IO_IDENTIFIER_NAMES.has(node.text);
}

export function touchesIo(before: string, after: string): boolean {
  const beforeFile = parseFragment(before);
  const afterFile = parseFragment(after);
  const { beforeChanged, afterChanged } = changedLineSets(before, after);
  return (
    anyChangedNodeMatches(beforeFile, beforeChanged, isIoNode) ||
    anyChangedNodeMatches(afterFile, afterChanged, isIoNode)
  );
}

export function labelHunk(before: string, after: string): AstProfileLabels {
  return {
    changeKind: classifyChangeKind(before, after),
    touchesPublicApi: touchesPublicApi(before, after),
    touchesErrorHandling: touchesErrorHandling(before, after),
    touchesAsync: touchesAsync(before, after),
    touchesIo: touchesIo(before, after),
  };
}
