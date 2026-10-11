// SPDX-License-Identifier: AGPL-3.0-only
// Sub F's append-only vm-parity ledger decoder (#3593) and the parity-history
// route's 500-log meta shapes (#4392), split out of adminVms.ts so the route
// file stays under the max-lines cap. The route is the only consumer; tests
// reach it through the route.
import { ZodError } from "zod";
import {
  VmParityHistoryEntrySchema,
  type VmParityHistoryEntry,
} from "@hapi/protocol/adminVms";

/** A zod issue reduced to its content-free locator (#4392). */
export type IssueLocator = { path: (string | number)[]; code: string };

/**
 * Path + code only. A zod issue's `message` / `input` can echo the value, but
 * its `path` over the flat, by-name schemas here is a field name, never data.
 */
function toIssueLocators(
  issues: readonly { path: readonly PropertyKey[]; code: string }[]
): IssueLocator[] {
  return issues.map(issue => ({
    path: issue.path.map(p => (typeof p === "number" ? p : String(p))),
    code: issue.code,
  }));
}

/** A thrown value's class name — never its message (which may quote data). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Every shape the parity-history route may log on a 500 (#4392). A CLOSED
 * union so that passing a message or a ledger / inventory value to the log is a
 * compile error, not a review catch.
 */
export type ParityHistoryLogMeta =
  | { path: "inventory"; kind: "unavailable"; code: string }
  | { path: "inventory"; kind: "unreadable" }
  | { path: "ledger-read"; code: string; name?: string }
  | {
      path: "ledger-decode";
      line: number;
      reason: VmParityLedgerDecodeReason;
      issues: IssueLocator[];
    }
  | { path: "ledger-decode" | "serialize"; reason: "unexpected"; name: string }
  | { path: "serialize"; issues: IssueLocator[] };

/** Log meta for a ledger decode failure (the decoder's own error, or not). */
export function decodeFailureMeta(err: unknown): ParityHistoryLogMeta {
  return err instanceof VmParityLedgerDecodeError
    ? {
        path: "ledger-decode",
        line: err.line,
        reason: err.reason,
        issues: err.issues,
      }
    : { path: "ledger-decode", reason: "unexpected", name: errorName(err) };
}

/** Log meta for an OUTPUT-schema (`.strict()`) failure at serialization. */
export function serializeFailureMeta(err: unknown): ParityHistoryLogMeta {
  return err instanceof ZodError
    ? { path: "serialize", issues: toIssueLocators(err.issues) }
    : { path: "serialize", reason: "unexpected", name: errorName(err) };
}

/** Log meta for a non-ENOENT ledger read failure. */
export function ledgerReadFailureMeta(err: unknown): ParityHistoryLogMeta {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  // A reader error with no errno (only an injected reader) is named instead.
  return code !== undefined
    ? { path: "ledger-read", code }
    : { path: "ledger-read", code: "unknown", name: errorName(err) };
}

/**
 * Decode Sub F's append-only vm-parity ledger (#3593) into served history
 * entries, in append order: one JSON object per non-blank line. Each entry is
 * built BY NAME from the eight served fields (the `toSanitizedEntry` idiom) —
 * never a spread — so a field F adds under `schema_version: 1` (an additive,
 * non-bumping change per its contract) is dropped instead of failing the
 * `.strict()` OUTPUT barrier, and nothing unserved (`target`, `checked_by`, …)
 * can ride along. THROWS on any line that is not a v1 record matching the
 * element schema: a corrupt ledger is a loud server fault, never a silently
 * shortened history. Every TERMINATED line is validated, including lines the
 * caller's filters would later drop, so a filter can never mask corruption. The
 * unterminated segment after the last "\n" is deferred WITHOUT validation (it
 * may be an append still in flight); a crashed partial write surfaces on the
 * next append, which terminates it into an invalid line.
 *
 * The thrown error is a `VmParityLedgerDecodeError` naming the 1-based physical
 * line and a reason code — never the line's content (#4392), so the route can
 * log a locator for a permanently-500ing append-only ledger without logging
 * ledger values.
 */
export function decodeVmParityLedger(text: string): VmParityHistoryEntry[] {
  const entries: VmParityHistoryEntry[] = [];
  const segments = text.split("\n");
  // F's writer ends every record with "\n" in ONE printf under O_APPEND, so the
  // segment after the last "\n" is not a record yet: "" normally, or a write
  // still in flight that this read tore (a buffered read takes no lock against
  // an appender — O_APPEND/PIPE_BUF only keeps WRITERS from interleaving). Defer
  // it to the next read. A CRASHED partial write is still loud: the next append
  // concatenates onto it, and that terminated line fails validation below.
  segments.pop();
  segments.forEach((line, i) => {
    if (line.trim() === "") return;
    const lineNo = i + 1; // physical line, blank lines counted (`sed -n Np`)
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      // Never carry the SyntaxError message: it can quote the bad token.
      throw new VmParityLedgerDecodeError(lineNo, "invalid-json");
    }
    if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
      throw new VmParityLedgerDecodeError(lineNo, "not-object");
    }
    const r = rec as Record<string, unknown>;
    // A breaking change bumps schema_version (F's contract); never serve a
    // renamed/retyped field under v1 meaning.
    if (r.schema_version !== 1) {
      throw new VmParityLedgerDecodeError(lineNo, "schema-version");
    }
    const parsed = VmParityHistoryEntrySchema.safeParse({
      subdomain: r.subdomain,
      checked_at: r.checked_at,
      verdict: r.verdict,
      compliant: r.compliant,
      drift: r.drift,
      manifest_version: r.manifest_version,
      checker_exit: r.checker_exit,
      source: r.source,
    });
    if (!parsed.success) {
      // Path + code only: a zod issue's message / input can echo the value.
      throw new VmParityLedgerDecodeError(
        lineNo,
        "schema",
        toIssueLocators(parsed.error.issues)
      );
    }
    entries.push(parsed.data);
  });
  return entries;
}

/** Why a ledger line failed to decode (#4392) — a content-free reason code. */
export type VmParityLedgerDecodeReason =
  | "invalid-json"
  | "not-object"
  | "schema-version"
  | "schema";

/**
 * A ledger decode failure that LOCATES the bad line without carrying it: the
 * 1-based physical line, a reason code, and (for `schema`) each zod issue's
 * path and code. The message is built only from those fields, so logging the
 * error can never leak a ledger value.
 */
export class VmParityLedgerDecodeError extends Error {
  constructor(
    readonly line: number,
    readonly reason: VmParityLedgerDecodeReason,
    readonly issues: IssueLocator[] = []
  ) {
    super(`vm-parity ledger line ${line}: ${reason}`);
    this.name = "VmParityLedgerDecodeError";
  }
}
