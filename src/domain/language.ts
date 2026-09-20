/**
 * Language detection from a file path, used to gate AST-based labeling
 * (SPEC §4.3 language gate): `ast-labels.ts` parses everything as
 * TypeScript, which is only meaningful for actual TypeScript/JavaScript
 * source. `hunk-profile.ts` uses this to decide whether `touchesPublicApi`
 * can be computed at all, and `review.ts` uses it for the `language` field
 * sent to the LLM reviewer's prompt — both callers go through this single
 * function so they never disagree on what a given path is.
 */

export type DetectedLanguage = "typescript" | "javascript" | "vue" | "php" | "blade" | "other";

const TYPESCRIPT_EXTENSIONS = new Set(["ts", "tsx"]);
const JAVASCRIPT_EXTENSIONS = new Set(["js", "jsx", "mjs", "cjs"]);

export function languageFromPath(path: string): DetectedLanguage {
  const lower = path.toLowerCase();
  if (lower.endsWith(".blade.php")) return "blade";
  if (lower.endsWith(".vue")) return "vue";
  if (lower.endsWith(".php")) return "php";

  const ext = lower.split(".").pop();
  if (ext !== undefined) {
    if (TYPESCRIPT_EXTENSIONS.has(ext)) return "typescript";
    if (JAVASCRIPT_EXTENSIONS.has(ext)) return "javascript";
  }
  return "other";
}

const VUE_SCRIPT_BLOCK_RE = /<script[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Extracts and concatenates every `<script>`/`<script setup>` block's
 * inner content from a `.vue` single-file component, so AST labeling can
 * run on the actual script code rather than the surrounding template
 * markup (which `ts.createSourceFile` would otherwise mangle). Returns
 * `null` when the source has no script block at all (template-only, or an
 * empty/unparsed fragment) — the caller treats that as "nothing to label".
 */
export function extractVueScript(source: string): string | null {
  const blocks = [...source.matchAll(VUE_SCRIPT_BLOCK_RE)].map((m) => m[1] ?? "");
  if (blocks.length === 0) {
    return null;
  }
  return blocks.join("\n");
}
