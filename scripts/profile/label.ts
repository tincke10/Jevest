#!/usr/bin/env -S npx tsx
/**
 * AST ground-truth labeler for the phase 0b surface-profile spike (H0',
 * SPEC §5 Fase 0b): reads `datasets/hunks.jsonl`, derives `change_kind`,
 * `touches_public_api`, `touches_error_handling`, `touches_async`, and
 * `touches_io` per hunk from its `before`/`after` text via the TypeScript
 * compiler API, and writes `datasets/profile-labels.jsonl`.
 *
 * These are a semi-automated seed, not verified ground truth — every
 * record carries `needs_manual_review: true`, mirroring `hunks.jsonl`'s
 * own labeling protocol (datasets/README.md §3).
 *
 * Usage: pnpm profile:label
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ProfileLabelRecord,
  serializeProfileLabelRecord,
} from "../../src/application/profile/profile-label-record.js";
import { parseHunkRecordsJsonl } from "../../src/application/spike/hunk-record.js";
import { labelHunk } from "../../src/domain/ast-labels.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HUNKS_PATH = join(REPO_ROOT, "datasets/hunks.jsonl");
const OUTPUT_PATH = join(REPO_ROOT, "datasets/profile-labels.jsonl");

async function main(): Promise<void> {
  const raw = await readFile(HUNKS_PATH, "utf8");
  const hunks = parseHunkRecordsJsonl(raw);

  const records: ProfileLabelRecord[] = hunks.map((hunk) => {
    const labels = labelHunk(hunk.before, hunk.after);
    return {
      hunkId: hunk.id,
      datasetVersion: hunk.datasetVersion,
      labels,
      source: "ast-v1",
      needsManualReview: true,
    };
  });

  const lines = records.map((record) => serializeProfileLabelRecord(record));
  await writeFile(OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");

  console.log(`[profile:label] wrote ${records.length} records to ${OUTPUT_PATH}`);
  console.log("");
  console.log("Label distribution:");

  const changeKindCounts = new Map<string, number>();
  for (const r of records) {
    changeKindCounts.set(r.labels.changeKind, (changeKindCounts.get(r.labels.changeKind) ?? 0) + 1);
  }
  console.log("  change_kind:");
  for (const [kind, count] of [...changeKindCounts].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / records.length) * 100).toFixed(1);
    console.log(`    ${kind}: ${count} (${pct}%)`);
  }

  for (const noul of [
    "touchesPublicApi",
    "touchesErrorHandling",
    "touchesAsync",
    "touchesIo",
  ] as const) {
    const trueCount = records.filter((r) => r.labels[noul]).length;
    const pct = (trueCount / records.length) * 100;
    const warning = pct > 90 || pct < 10 ? "  <-- WARNING: >90% one class, useless for H0'" : "";
    console.log(`  ${noul}: ${trueCount}/${records.length} true (${pct.toFixed(1)}%)${warning}`);
  }
}

main().catch((error: unknown) => {
  console.error("[profile:label] error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
