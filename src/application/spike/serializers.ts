import type { State } from "../../domain/ports/decision-port.js";
/**
 * The three hunk serialization formats being compared for H0 (SPEC §5 Fase
 * 0): raw diff, JSON {file, language, before, after}, and JSON with more
 * file context. Per NFR-4/5, none of them include labels, evidence, commit
 * messages, or numeric counts — only what Jev needs to judge the code.
 */
import type { HunkRecord } from "./hunk-record.js";

export interface HunkSerializer {
  readonly name: string;
  serialize(hunk: HunkRecord): State;
}

export const rawDiff: HunkSerializer = {
  name: "raw-diff",
  serialize(hunk: HunkRecord): State {
    return hunk.diff;
  },
};

export const beforeAfterJson: HunkSerializer = {
  name: "before-after-json",
  serialize(hunk: HunkRecord): State {
    return {
      file: hunk.file,
      language: hunk.language,
      before: hunk.before,
      after: hunk.after,
    };
  },
};

export const jsonWithContext: HunkSerializer = {
  name: "json-with-context",
  serialize(hunk: HunkRecord): State {
    return {
      repo: hunk.repo,
      file: hunk.file,
      language: hunk.language,
      hunk_header: hunk.hunkHeader,
      before: hunk.before,
      after: hunk.after,
      diff: hunk.diff,
    };
  },
};

const registry: Record<string, HunkSerializer> = {
  [rawDiff.name]: rawDiff,
  [beforeAfterJson.name]: beforeAfterJson,
  [jsonWithContext.name]: jsonWithContext,
};

export function listSerializerNames(): string[] {
  return Object.keys(registry);
}

export function getSerializer(name: string): HunkSerializer {
  const serializer = registry[name];
  if (!serializer) {
    throw new Error(`unknown serializer "${name}"; available: ${listSerializerNames().join(", ")}`);
  }
  return serializer;
}
