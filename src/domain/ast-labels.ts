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

/**
 * A structural fingerprint of the fragment: node kinds only, with
 * identifiers normalized (name text dropped) so a pure rename doesn't
 * change the signature, but literal values are kept (a changed literal is
 * a real change, not a rename).
 */
function structuralSignature(sourceFile: ts.SourceFile): string {
  const parts: string[] = [];
  forEachDescendant(sourceFile, (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      parts.push("Identifier");
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
      parts.push(`${ts.SyntaxKind[node.kind]}:${node.text}`);
      return;
    }
    parts.push(ts.SyntaxKind[node.kind]);
  });
  return parts.join("|");
}

/** Statements plus call expressions: a simple proxy for "how much behavior surface" a fragment has. */
function behaviorSurfaceCount(sourceFile: ts.SourceFile): number {
  let count = 0;
  forEachDescendant(sourceFile, (node) => {
    if (ts.isStatement(node) || ts.isCallExpression(node)) {
      count++;
    }
  });
  return count;
}

/**
 * Rule (kept intentionally simple and deterministic):
 * 1. If the before/after structural signatures are identical (same AST
 *    shape modulo identifier names, literal values kept), it's a pure
 *    rename or formatting change: "rename-or-format".
 * 2. Otherwise, compare a behavior-surface count (statements + calls):
 *    more in `after` -> "add-behavior"; fewer -> "delete" (net removal);
 *    equal but structurally different -> "modify-behavior" (same shape of
 *    code, different content — e.g. a changed condition or operator).
 */
export function classifyChangeKind(before: string, after: string): ChangeKind {
  const beforeFile = parseFragment(before);
  const afterFile = parseFragment(after);

  if (structuralSignature(beforeFile) === structuralSignature(afterFile)) {
    return "rename-or-format";
  }

  const beforeCount = behaviorSurfaceCount(beforeFile);
  const afterCount = behaviorSurfaceCount(afterFile);

  if (afterCount > beforeCount) return "add-behavior";
  if (afterCount < beforeCount) return "delete";
  return "modify-behavior";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function isExported(node: ts.Node): boolean {
  return (
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ||
    hasModifier(node, ts.SyntaxKind.DefaultKeyword)
  );
}

/** A normalized signature string per exported top-level declaration, keyed by name. */
function exportedSignatures(sourceFile: ts.SourceFile): Map<string, string> {
  const signatures = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const params = statement.parameters.map((p) => p.getText(sourceFile)).join(",");
      const returnType = statement.type?.getText(sourceFile) ?? "";
      signatures.set(statement.name.text, `function(${params}):${returnType}`);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const members = statement.members
        .filter((m) => !hasModifier(m, ts.SyntaxKind.PrivateKeyword))
        .map((m) => m.getText(sourceFile))
        .sort()
        .join(";");
      signatures.set(statement.name.text, `class{${members}}`);
    } else if (ts.isInterfaceDeclaration(statement)) {
      signatures.set(statement.name.text, `interface:${statement.getText(sourceFile)}`);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      signatures.set(statement.name.text, `type:${statement.getText(sourceFile)}`);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const typeText = decl.type?.getText(sourceFile) ?? "";
          signatures.set(decl.name.text, `var:${typeText}`);
        }
      }
    }
  }

  return signatures;
}

/** True when the set of exported names, or any shared name's signature, differs. */
export function touchesPublicApi(before: string, after: string): boolean {
  const beforeSignatures = exportedSignatures(parseFragment(before));
  const afterSignatures = exportedSignatures(parseFragment(after));

  if (beforeSignatures.size !== afterSignatures.size) return true;

  for (const [name, signature] of beforeSignatures) {
    if (afterSignatures.get(name) !== signature) return true;
  }
  return false;
}

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function hasErrorHandlingSurface(sourceFile: ts.SourceFile): boolean {
  let found = false;
  forEachDescendant(sourceFile, (node) => {
    if (found) return;
    if (ts.isTryStatement(node) || ts.isThrowStatement(node) || ts.isCatchClause(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name && /Error/i.test(name)) {
        found = true;
      }
    }
  });
  return found;
}

export function touchesErrorHandling(before: string, after: string): boolean {
  return (
    hasErrorHandlingSurface(parseFragment(before)) || hasErrorHandlingSurface(parseFragment(after))
  );
}

const ASYNC_CALL_NAMES = new Set(["setTimeout", "queueMicrotask", "then"]);

function hasAsyncSurface(sourceFile: ts.SourceFile): boolean {
  let found = false;
  forEachDescendant(sourceFile, (node) => {
    if (found) return;
    if (ts.isAwaitExpression(node)) {
      found = true;
      return;
    }
    if (hasModifier(node, ts.SyntaxKind.AsyncKeyword)) {
      found = true;
      return;
    }
    if (ts.isIdentifier(node) && node.text === "Promise") {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name && ASYNC_CALL_NAMES.has(name)) {
        found = true;
      }
    }
  });
  return found;
}

export function touchesAsync(before: string, after: string): boolean {
  return hasAsyncSurface(parseFragment(before)) || hasAsyncSurface(parseFragment(after));
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

function hasIoSurface(sourceFile: ts.SourceFile): boolean {
  let found = false;
  forEachDescendant(sourceFile, (node) => {
    if (found) return;
    if (ts.isIdentifier(node) && IO_IDENTIFIER_NAMES.has(node.text)) {
      found = true;
    }
  });
  return found;
}

export function touchesIo(before: string, after: string): boolean {
  return hasIoSurface(parseFragment(before)) || hasIoSurface(parseFragment(after));
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
