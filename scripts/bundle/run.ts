/**
 * `pnpm bundle`: builds dist/main.mjs from src/action/main.ts.
 * CI ONLY — run by .github/workflows/release.yml. Do not run it locally:
 * the bundle that ships is always the one the Release workflow produced
 * from the tagged source (docs/RELEASING.md).
 */
import { build } from "esbuild";
import { bundleOptions } from "./options.js";

if (process.env.CI !== "true") {
  console.error(
    "pnpm bundle: refusing to run outside CI. The Action bundle is produced only by the Release workflow (docs/RELEASING.md).",
  );
  process.exit(1);
}

await build(bundleOptions);
