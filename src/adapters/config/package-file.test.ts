import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePackageFile } from "./package-file.js";

const ROOT = "/action";
const EXAMPLE = "config/jevest.example.yml";

function fakeFs(...files: string[]): (path: string) => boolean {
  const set = new Set(files);
  return (path) => set.has(path);
}

describe("resolvePackageFile", () => {
  it("finds the file from the source layout (tsx: src/adapters/config)", () => {
    const exists = fakeFs(join(ROOT, EXAMPLE));
    expect(resolvePackageFile(EXAMPLE, join(ROOT, "src/adapters/config"), exists)).toBe(
      join(ROOT, EXAMPLE),
    );
  });

  it("finds the file from the bundle layout (node dist/main.mjs)", () => {
    const exists = fakeFs(join(ROOT, EXAMPLE));
    expect(resolvePackageFile(EXAMPLE, join(ROOT, "dist"), exists)).toBe(join(ROOT, EXAMPLE));
  });

  it("prefers the nearest ancestor", () => {
    const exists = fakeFs(join(ROOT, EXAMPLE), join(ROOT, "dist", EXAMPLE));
    expect(resolvePackageFile(EXAMPLE, join(ROOT, "dist"), exists)).toBe(
      join(ROOT, "dist", EXAMPLE),
    );
  });

  it("throws naming the file and the start directory when no ancestor has it", () => {
    expect(() => resolvePackageFile(EXAMPLE, join(ROOT, "dist"), fakeFs())).toThrow(
      /config\/jevest\.example\.yml.*\/action\/dist/,
    );
  });

  it("resolves the real example config from this source file", () => {
    const path = resolvePackageFile(EXAMPLE, import.meta.dirname);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(import.meta.dirname, "../../..", EXAMPLE));
  });
});
