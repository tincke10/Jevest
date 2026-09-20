import { describe, expect, it } from "vitest";
import { extractVueScript, languageFromPath } from "./language.js";

describe("languageFromPath", () => {
  it.each([
    ["src/a.ts", "typescript"],
    ["src/a.tsx", "typescript"],
    ["src/a.js", "javascript"],
    ["src/a.jsx", "javascript"],
    ["src/a.mjs", "javascript"],
    ["src/a.cjs", "javascript"],
    ["src/components/Widget.vue", "vue"],
    ["app/Http/Controllers/UserController.php", "php"],
    ["resources/views/welcome.blade.php", "blade"],
    ["README.md", "other"],
    ["scripts/deploy.sh", "other"],
    ["src/a.TS", "typescript"],
    ["resources/views/WELCOME.BLADE.PHP", "blade"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(languageFromPath(path)).toBe(expected);
  });

  it("classifies a path with no extension as other", () => {
    expect(languageFromPath("Makefile")).toBe("other");
  });
});

describe("extractVueScript", () => {
  it("extracts the contents of a plain <script> block", () => {
    const source = [
      "<template><div>{{ msg }}</div></template>",
      "<script>",
      "export default { data() { return { msg: 'hi' }; } };",
      "</script>",
    ].join("\n");
    const result = extractVueScript(source);
    expect(result).toContain("export default");
    expect(result).not.toContain("<template>");
  });

  it("extracts the contents of a <script setup> block", () => {
    const source = [
      "<template><div>{{ msg }}</div></template>",
      '<script setup lang="ts">',
      "export function greet(name: string) { return `hi ${name}`; }",
      "</script>",
    ].join("\n");
    const result = extractVueScript(source);
    expect(result).toContain("export function greet");
  });

  it("concatenates multiple script blocks when both are present", () => {
    const source = [
      "<script>export const a = 1;</script>",
      "<script setup>export const b = 2;</script>",
    ].join("\n");
    const result = extractVueScript(source);
    expect(result).toContain("export const a = 1;");
    expect(result).toContain("export const b = 2;");
  });

  it("returns null when there is no script block", () => {
    const source = "<template><div>static</div></template>";
    expect(extractVueScript(source)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractVueScript("")).toBeNull();
  });
});
