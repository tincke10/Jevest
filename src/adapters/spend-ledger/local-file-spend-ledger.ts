/**
 * SpendLedgerPort over a JSON file, for `pnpm review` local runs (SPEC §5
 * Fase 1b): a local CLI has no consumer repo to keep an issue in, but the
 * pipeline still wants a ledger to read and record so the cap behaves the
 * same way it does in CI. Default location is `.jevest/spend-ledger.json`
 * (git-ignored). Parent directories are created on first write; a missing
 * file reads as `null` ("nothing recorded yet"), any other read error
 * still throws.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SpendLedgerPort } from "../../domain/ports/spend-ledger-port.js";
import { type SpendLedger, applySpendEntry } from "../../domain/spend-cap.js";
import { createKeyedMutex } from "../concurrency/keyed-mutex.js";
import { decodeSpendLedger, encodeSpendLedger } from "./spend-ledger-codec.js";

/**
 * `record` is read-modify-write: concurrent eval cases (`--concurrency n`)
 * sharing one ledger file would lose entries or tear the JSON. Serialized
 * per file path in this process, and the file is replaced atomically
 * (temp + rename) so a reader never sees a half-written ledger.
 */
const recordMutex = createKeyedMutex();
let tmpCounter = 0;

export interface LocalFileSpendLedgerOptions {
  readonly filePath: string;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createLocalFileSpendLedger(options: LocalFileSpendLedgerOptions): SpendLedgerPort {
  const { filePath } = options;

  async function read(): Promise<SpendLedger | null> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) {
        return null;
      }
      throw error;
    }
    return decodeSpendLedger(raw, filePath);
  }

  return {
    read,
    record(entry) {
      return recordMutex.run(filePath, async () => {
        const next = applySpendEntry(await read(), entry);
        await mkdir(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
        await writeFile(tmp, `${JSON.stringify(encodeSpendLedger(next), null, 2)}\n`, "utf8");
        await rename(tmp, filePath);
        return next;
      });
    },
  };
}
