/**
 * esbuild options for the Action bundle (`pnpm bundle`, docs/RELEASING.md).
 * Only the Release workflow runs the bundle; it is never built on a
 * developer machine and never committed to `main`.
 *
 * - One self-contained ESM file: every dependency is inlined, so a run of the
 *   bundled Action needs neither pnpm nor `pnpm install`.
 * - `require` banner: some dependencies are CommonJS (e.g. picomatch). Once
 *   inlined into an ESM file, their `require("node:path")` calls go through
 *   esbuild's `__require` shim, which throws "Dynamic require of ... is not
 *   supported" unless a real `require` is in scope.
 * - `import.meta` is left as is in ESM output, so `import.meta.dirname` is
 *   `dist/` for every inlined module: files Jevest reads at runtime are
 *   located with `resolvePackageFile` (src/adapters/config/package-file.ts),
 *   never with a fixed relative path.
 */
import type { BuildOptions } from "esbuild";

export const BUNDLE_OUTFILE = "dist/main.mjs";

export const bundleOptions: BuildOptions = {
  entryPoints: ["src/action/main.ts"],
  outfile: BUNDLE_OUTFILE,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
  banner: {
    js: [
      'import { createRequire as __jevestCreateRequire } from "node:module";',
      "const require = __jevestCreateRequire(import.meta.url);",
    ].join("\n"),
  },
};
