import { describe, expect, it } from "vitest";
import { BUNDLE_OUTFILE, bundleOptions } from "./options.js";

describe("bundleOptions", () => {
  it("bundles the Action entrypoint into one ESM file for Node 22", () => {
    expect(bundleOptions.entryPoints).toEqual(["src/action/main.ts"]);
    expect(bundleOptions.outfile).toBe(BUNDLE_OUTFILE);
    expect(BUNDLE_OUTFILE).toBe("dist/main.mjs");
    expect(bundleOptions).toMatchObject({
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: true,
    });
  });

  it("inlines every dependency (nothing external, so no node_modules at runtime)", () => {
    expect(bundleOptions.external ?? []).toEqual([]);
    expect(bundleOptions.packages).toBeUndefined();
  });

  it("defines `require` for the CommonJS dependencies inlined into the ESM bundle", () => {
    expect(bundleOptions.banner?.js).toContain('from "node:module"');
    expect(bundleOptions.banner?.js).toMatch(/const require = \w+\(import\.meta\.url\);/);
  });

  it("defines `__filename` and `__dirname` for inlined CommonJS that reads them (the TypeScript compiler does)", () => {
    const banner = bundleOptions.banner?.js ?? "";
    expect(banner).toContain('from "node:url"');
    expect(banner).toMatch(/const __filename = \w+\(import\.meta\.url\);/);
    expect(banner).toContain('from "node:path"');
    expect(banner).toMatch(/const __dirname = \w+\(__filename\);/);
  });
});
