/** Reads an eval run's results.json from its directory (or the file itself). */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EVAL_RESULTS_SCHEMA_VERSION,
  type EvalResults,
} from "../../src/application/eval/eval-run.js";

export async function loadEvalResults(path: string): Promise<EvalResults> {
  const file = (await stat(path)).isDirectory() ? join(path, "results.json") : path;
  const results = JSON.parse(await readFile(file, "utf8")) as EvalResults;
  if (results.schema !== EVAL_RESULTS_SCHEMA_VERSION) {
    throw new Error(`${file}: unsupported results schema ${String(results.schema)}`);
  }
  return results;
}
