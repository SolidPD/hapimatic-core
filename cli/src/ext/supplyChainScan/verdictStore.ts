// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-artifact supply-chain scan verdict + override store (issue #3131, Sub Q — R1/R4).
 *
 * Persists one row per scanned artifact: its verdict, findings, scan time, and — when an
 * operator overrode a block — who/when/why. The store is queryable so a verdict is
 * "stored and queryable" (R1), and an override records who/when/why and applies to THAT
 * artifact ONLY (R4 — never a global bypass; the row key IS the artifact id).
 *
 * ── DDL ownership: a DELIBERATE divergence from `ext/prefs.ts` (KD4 / ruling 1B-18) ──
 * `ext/prefs.ts` + `ext/sqlite.ts` NEVER create tables: `extension_prefs` lives in the
 * server's instance DB and is created by the server's `runMigrations()`; the CLI callers
 * guard on existence so the loader HOT PATH cannot materialize an empty DB or a phantom
 * table. This store deliberately diverges: it runs `CREATE TABLE IF NOT EXISTS
 * ext_scan_verdicts (...)` ON OPEN, reusing the runtime-adaptive `ext/sqlite.ts` accessor
 * against the SAME instance DB (`${HAPI_HOME}/hapi.db`). The divergence is SAFE — and
 * intentionally NOT a licence to cargo-cult table creation into the prefs convention —
 * because this store opens ONLY on an install / override action, NEVER on the loader hot
 * path. The DB FILE itself is still existence-guarded like prefs (the CLI never
 * materializes the instance DB); the store creates only the TABLE, on an already-present
 * DB.
 *
 * ── Fail-soft writes ──
 * A persistence failure must NEVER crash a security scan's block/pass decision. When the
 * instance DB is absent (a server-less instance), writes best-effort warn + skip rather
 * than throw (unlike `prefs.setCliExtensionPref`, which throws loud — a verdict record is
 * advisory audit, not a user-requested state change). The block/pass verdict is computed
 * independently in `scanner.ts` and is unaffected by a storage miss; a missing store on a
 * server-less instance also means an override cannot be persisted, which fails CLOSED
 * (the safe direction for a security gate).
 *
 * ── Fail-closed list ──
 * `listScanVerdicts` is the exception: its only caller is `hapi security audit`, which must
 * not read an unreadable or corrupt store as "no blocked extension" (#4886 N3). It throws
 * instead of warning (a warning is `console.log`, which would also corrupt `--json`).
 */
import { existsSync, lstatSync } from "node:fs";

import type { ScanFinding } from "@hapi/protocol";

import { logger } from "@/ui/logger";

import { openDatabase, resolveDbPath, type PortableDatabase } from "../sqlite";

const DDL = `CREATE TABLE IF NOT EXISTS ext_scan_verdicts (
  artifact_id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL,
  findings TEXT NOT NULL,
  scanned_at INTEGER NOT NULL,
  override_by TEXT,
  override_at INTEGER,
  override_reason TEXT
)`;

/** One persisted scan verdict record (the shape reads return). */
export interface StoredScanVerdict {
  artifactId: string;
  verdict: "pass" | "block";
  findings: ScanFinding[];
  scannedAt: number;
  /** Present only when an operator overrode a block for THIS artifact (R4). */
  override: { by: string; at: number; reason: string } | null;
}

/** Options — `dbPath` override lets tests point at a temp instance DB. */
export interface VerdictStoreOptions {
  dbPath?: string;
}

function resolvePath(opts?: VerdictStoreOptions): string {
  return opts?.dbPath ?? resolveDbPath();
}

/** True when the open DB carries the `ext_scan_verdicts` table. */
function tableReady(db: PortableDatabase): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ext_scan_verdicts'"
    )
    .get() as { name: string } | undefined;
  return row != null;
}

/**
 * Open the instance DB read-write and ensure the table exists (KD4 DDL-on-open). Returns
 * `null` when the DB FILE is absent (best-effort: never materialize the instance DB from
 * the CLI). Callers treat `null` as "persistence unavailable — skip".
 */
function openRW(dbPath: string): PortableDatabase | null {
  if (!existsSync(dbPath)) return null;
  const db = openDatabase(dbPath, false);
  db.prepare(DDL).run();
  return db;
}

/** Open the instance DB read-only. Returns `null` when the file is absent. */
function openRO(dbPath: string): PortableDatabase | null {
  if (!existsSync(dbPath)) return null;
  return openDatabase(dbPath, true);
}

function rowToRecord(row: {
  artifact_id: string;
  verdict: string;
  findings: string;
  scanned_at: number;
  override_by: string | null;
  override_at: number | null;
  override_reason: string | null;
}): StoredScanVerdict {
  let findings: ScanFinding[] = [];
  try {
    findings = JSON.parse(row.findings) as ScanFinding[];
  } catch {
    findings = [];
  }
  return {
    artifactId: row.artifact_id,
    verdict: row.verdict === "block" ? "block" : "pass",
    findings,
    scannedAt: Number(row.scanned_at),
    override:
      row.override_by != null && row.override_at != null
        ? {
            by: row.override_by,
            at: Number(row.override_at),
            reason: row.override_reason ?? "",
          }
        : null,
  };
}

/**
 * Record (upsert) an artifact's scan verdict + findings (R1). Best-effort: a missing
 * instance DB warns + returns `false` rather than throwing. On conflict the verdict,
 * findings, and scan time are refreshed while any EXISTING override is PRESERVED (a
 * re-scan must not silently erase a logged override).
 */
export function recordScanVerdict(
  artifactId: string,
  verdict: { verdict: "pass" | "block"; findings: ScanFinding[] },
  now: number = Date.now(),
  opts?: VerdictStoreOptions
): boolean {
  const dbPath = resolvePath(opts);
  const db = openRW(dbPath);
  if (!db) {
    logger.warn(
      `[ext:scan] instance DB absent at ${dbPath}; scan verdict for '${artifactId}' not persisted (best-effort)`
    );
    return false;
  }
  try {
    db.prepare(
      "INSERT INTO ext_scan_verdicts (artifact_id, verdict, findings, scanned_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(artifact_id) DO UPDATE SET verdict = excluded.verdict, findings = excluded.findings, scanned_at = excluded.scanned_at"
    ).run(artifactId, verdict.verdict, JSON.stringify(verdict.findings), now);
    return true;
  } catch (err) {
    logger.warn(
      `[ext:scan] failed to persist verdict for '${artifactId}':`,
      err
    );
    return false;
  } finally {
    db.close();
  }
}

/**
 * Record an operator override of a blocked artifact (R4 — who/when/why, per-artifact).
 * Upserts the override columns for THAT artifact only. If no verdict row exists yet, one
 * is inserted marking the (overridden) block. Best-effort like {@link recordScanVerdict}.
 */
export function recordScanOverride(
  artifactId: string,
  by: string,
  reason: string,
  now: number = Date.now(),
  opts?: VerdictStoreOptions
): boolean {
  const dbPath = resolvePath(opts);
  const db = openRW(dbPath);
  if (!db) {
    logger.warn(
      `[ext:scan] instance DB absent at ${dbPath}; override for '${artifactId}' not persisted (fails closed)`
    );
    return false;
  }
  try {
    db.prepare(
      "INSERT INTO ext_scan_verdicts (artifact_id, verdict, findings, scanned_at, override_by, override_at, override_reason) " +
        "VALUES (?, 'block', '[]', ?, ?, ?, ?) " +
        "ON CONFLICT(artifact_id) DO UPDATE SET override_by = excluded.override_by, override_at = excluded.override_at, override_reason = excluded.override_reason"
    ).run(artifactId, now, by, now, reason);
    return true;
  } catch (err) {
    logger.warn(
      `[ext:scan] failed to persist override for '${artifactId}':`,
      err
    );
    return false;
  } finally {
    db.close();
  }
}

/** Read one artifact's stored verdict. Returns `null` when absent / DB unavailable. */
export function getScanVerdict(
  artifactId: string,
  opts?: VerdictStoreOptions
): StoredScanVerdict | null {
  const db = openRO(resolvePath(opts));
  if (!db) return null;
  try {
    if (!tableReady(db)) return null;
    const row = db
      .prepare("SELECT * FROM ext_scan_verdicts WHERE artifact_id = ?")
      .get(artifactId) as Parameters<typeof rowToRecord>[0] | undefined;
    return row ? rowToRecord(row) : null;
  } catch (err) {
    logger.warn(`[ext:scan] read failed for '${artifactId}':`, err);
    return null;
  } finally {
    db.close();
  }
}

/** Read one artifact's override record (who/when/why), or `null`. */
export function getScanOverride(
  artifactId: string,
  opts?: VerdictStoreOptions
): { by: string; at: number; reason: string } | null {
  return getScanVerdict(artifactId, opts)?.override ?? null;
}

/**
 * Enumerate every stored verdict in artifact-id order (queryable — R1). Fails closed
 * (#4886 N3): an absent DB file (a server-less instance) or table is genuinely empty, but
 * a DB that cannot be opened or queried, or a row whose verdict is neither `pass` nor
 * `block`, throws. A busy DB is waited on (up to 3 s) rather than read as a failure.
 */
export function listScanVerdicts(
  opts?: VerdictStoreOptions
): StoredScanVerdict[] {
  const dbPath = resolvePath(opts);
  try {
    lstatSync(dbPath); // unlike existsSync, an untraversable parent is not "absent"
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
  const db = openDatabase(dbPath, true);
  try {
    db.prepare("PRAGMA busy_timeout = 3000").get();
    if (!tableReady(db)) return [];
    const rows = db
      .prepare("SELECT * FROM ext_scan_verdicts ORDER BY artifact_id ASC")
      .all() as Parameters<typeof rowToRecord>[0][];
    return rows.map(row => {
      if (row.verdict !== "pass" && row.verdict !== "block") {
        throw Object.assign(
          new Error(
            `stored verdict for '${row.artifact_id}' is neither pass nor block`
          ),
          { code: "UNKNOWN_VERDICT" }
        );
      }
      return rowToRecord(row);
    });
  } finally {
    db.close();
  }
}
