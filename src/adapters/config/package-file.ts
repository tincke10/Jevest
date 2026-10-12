/**
 * Locates a file shipped with Jevest itself (e.g. `config/jevest.example.yml`)
 * from the directory of the code that needs it, in both runtime layouts:
 *
 * - source, run with `tsx`: the caller lives in `src/adapters/config/`, three
 *   levels below the package root;
 * - bundle, run with `node dist/main.mjs`: everything is inlined into one
 *   file in `dist/`, one level below the root, so `import.meta.dirname` is
 *   `dist/` for every module.
 *
 * A fixed `../../../` only works for the first one, so this walks up from
 * `startDir` and returns the nearest `<ancestor>/<relativePath>` that exists.
 * The Action checkout always contains the whole repo (`config/` included),
 * so the bundle needs no copy of the file next to it.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolvePackageFile(
  relativePath: string,
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, relativePath);
    if (exists(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`jevest: ${relativePath} not found in ${startDir} or any parent directory`);
    }
    dir = parent;
  }
}
