import { describe, expect, it } from "vitest";
import {
  FULL_FILE_MAX_CHARS,
  FULL_FILE_MAX_LINES,
  FULL_FILE_WINDOW_RADIUS,
  buildFullFileContext,
  hunkNewRange,
} from "./file-context.js";

function numbered(count: number, prefix = "line"): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n");
}

describe("hunkNewRange", () => {
  it("reads the after-side start and length from the header", () => {
    expect(hunkNewRange("@@ -10,4 +12,6 @@ function x(")).toEqual({ start: 12, end: 17 });
  });

  it("treats a missing length as 1 and a zero length as the start line", () => {
    expect(hunkNewRange("@@ -1 +3 @@")).toEqual({ start: 3, end: 3 });
    expect(hunkNewRange("@@ -5,2 +4,0 @@")).toEqual({ start: 4, end: 4 });
  });

  it("returns null for a malformed header", () => {
    expect(hunkNewRange("not a header")).toBeNull();
  });
});

describe("buildFullFileContext", () => {
  it("returns the whole file when it is under both caps", () => {
    const context = buildFullFileContext("src/a.ts", numbered(50), { start: 10, end: 12 });
    expect(context.mode).toBe("full");
    expect(context.totalLines).toBe(50);
    expect(context.segments).toEqual([{ startLine: 1, lines: numbered(50).split("\n") }]);
    expect(context.chars).toBe(numbered(50).length);
  });

  it("drops a single trailing newline instead of counting an empty last line", () => {
    const context = buildFullFileContext("src/a.ts", "a\nb\n", { start: 1, end: 1 });
    expect(context.totalLines).toBe(2);
    expect(context.segments[0]?.lines).toEqual(["a", "b"]);
  });

  it("switches to a window of ±150 lines around the hunk when the file has too many lines", () => {
    const total = FULL_FILE_MAX_LINES + 500;
    const context = buildFullFileContext("src/big.ts", numbered(total), { start: 1000, end: 1004 });
    expect(context.mode).toBe("window");
    expect(context.totalLines).toBe(total);
    expect(context.segments).toHaveLength(1);
    const [segment] = context.segments;
    expect(segment?.startLine).toBe(1000 - FULL_FILE_WINDOW_RADIUS);
    expect(segment?.lines[0]).toBe(`line ${1000 - FULL_FILE_WINDOW_RADIUS}`);
    expect(segment?.lines.at(-1)).toBe(`line ${1004 + FULL_FILE_WINDOW_RADIUS}`);
  });

  it("adds the import / use / require block as its own segment in window mode", () => {
    const head = [
      "<?php",
      "",
      "namespace App\\Services;",
      "",
      "use App\\Models\\Order;",
      "use Illuminate\\Support\\Facades\\Cache;",
      "",
    ];
    const body = Array.from({ length: 2600 }, (_, i) => `// body ${i + 8}`);
    const content = [...head, ...body].join("\n");
    const context = buildFullFileContext("app/Services/OrderService.php", content, {
      start: 2000,
      end: 2001,
    });
    expect(context.mode).toBe("window");
    expect(context.segments).toHaveLength(2);
    expect(context.segments[0]).toEqual({
      startLine: 5,
      lines: ["use App\\Models\\Order;", "use Illuminate\\Support\\Facades\\Cache;"],
    });
    expect(context.segments[1]?.startLine).toBe(2000 - FULL_FILE_WINDOW_RADIUS);
  });

  it("recognizes JS imports and requires", () => {
    const head = [
      "import { ref } from 'vue';",
      "import axios from 'axios';",
      "const fs = require('node:fs');",
    ];
    const body = Array.from({ length: 2500 }, (_, i) => `x${i}();`);
    const context = buildFullFileContext("src/x.js", [...head, ...body].join("\n"), {
      start: 1500,
      end: 1500,
    });
    expect(context.segments[0]).toEqual({ startLine: 1, lines: head });
  });

  it("merges the import block into the window when they overlap", () => {
    const content = ["import a from 'a';", ...Array.from({ length: 2500 }, () => "x();")].join(
      "\n",
    );
    const context = buildFullFileContext("src/x.ts", content, { start: 20, end: 20 });
    expect(context.segments).toHaveLength(1);
    expect(context.segments[0]?.startLine).toBe(1);
  });

  it("switches to a window when the file is over the char cap, and trims the window to fit", () => {
    const long = "y".repeat(500);
    const content = Array.from({ length: 1000 }, () => long).join("\n");
    expect(content.length).toBeGreaterThan(FULL_FILE_MAX_CHARS);
    const context = buildFullFileContext("src/wide.ts", content, { start: 500, end: 500 });
    expect(context.mode).toBe("window");
    expect(context.chars).toBeLessThanOrEqual(FULL_FILE_MAX_CHARS);
    const segment = context.segments[0];
    expect(segment).toBeDefined();
    // Still centered on the hunk.
    const first = segment?.startLine ?? 0;
    const last = first + (segment?.lines.length ?? 0) - 1;
    expect(first).toBeLessThanOrEqual(500);
    expect(last).toBeGreaterThanOrEqual(500);
  });

  it("clips a single very long line instead of blowing the cap", () => {
    const content = `short\n${"z".repeat(FULL_FILE_MAX_CHARS * 2)}\nshort`;
    const context = buildFullFileContext("dist/app.min.js", content, { start: 2, end: 2 });
    expect(context.chars).toBeLessThanOrEqual(FULL_FILE_MAX_CHARS);
    expect(context.segments.flatMap((s) => s.lines).some((l) => l.endsWith("[clipped]"))).toBe(
      true,
    );
  });
});
