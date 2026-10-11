// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  ImpactArtifactSchema,
  UpdateSpanSchema,
  validateImpactArtifact,
  versionRangeKey,
  type ImpactArtifact,
  type UpdateSpan,
} from "@hapi/protocol";
import { safeJsonParse } from "./json";

/**
 * Impact-analysis artifact sub-store (issue #1772, Sub C of epic #1769).
 * Persists one row per `(node_id, harness_id, version_range)` in the
 * `claude_update_analysis` table (created in `store/index.ts` `runMigrations()`).
 * A thin `Database` wrapper mirroring `harnessStore.ts`.
 *
 * The primary key's `version_range` component is the canonical
 * `versionRangeKey(from, to)` output (R10) — writer and reader derive the key
 * through the ONE shared function so a lookup can never mis-hit on a whitespace
 * or join difference. `harness_id` carries the registry's generic dimension so a
 * future non-`claude-code` harness slots in without a schema change.
 *
 * Two blobs are stored as TEXT:
 *   - `artifact_json`  — the validated `ImpactArtifact` (Zod-validated BEFORE
 *                        insert, R2 defense-in-depth; the submit endpoint already
 *                        validated + returned 400, so a throw here is a fail-loud
 *                        invariant guard, never a user-reachable path).
 *   - `seed_span_json` — the `UpdateSpan` that seeded the analysis, persisted so
 *                        a fresh companion can be RE-SEEDED after the original
 *                        peer decays (#1774 depends on this surviving the update).
 */

/** The fields the submit endpoint / orchestrator writes. The artifact + span are
 *  passed as objects (validated + serialized here), not pre-stringified JSON. */
export interface ImpactAnalysisUpsert {
  node_id: string;
  harness_id: string;
  version_from: string;
  version_to: string;
  analyzed_at: number;
  peer_session_id: string | null;
  artifact: ImpactArtifact;
  seed_span: UpdateSpan;
}

/** A read-back record: metadata columns + the parsed blobs (null when a blob
 *  fails to parse/validate — never throws on read). */
export interface ImpactAnalysisRecord {
  node_id: string;
  harness_id: string;
  version_range: string;
  version_from: string;
  version_to: string;
  analyzed_at: number;
  peer_session_id: string | null;
  artifact: ImpactArtifact | null;
  seed_span: UpdateSpan | null;
}

/** The raw DB row shape (blobs are TEXT). */
interface ImpactAnalysisRow {
  node_id: string;
  harness_id: string;
  version_range: string;
  version_from: string;
  version_to: string;
  analyzed_at: number;
  peer_session_id: string | null;
  artifact_json: string;
  seed_span_json: string;
}

function rowToRecord(row: ImpactAnalysisRow): ImpactAnalysisRecord {
  const artifactParsed = ImpactArtifactSchema.safeParse(
    safeJsonParse(row.artifact_json)
  );
  const spanParsed = UpdateSpanSchema.safeParse(
    safeJsonParse(row.seed_span_json)
  );
  return {
    node_id: row.node_id,
    harness_id: row.harness_id,
    version_range: row.version_range,
    version_from: row.version_from,
    version_to: row.version_to,
    analyzed_at: row.analyzed_at,
    peer_session_id: row.peer_session_id,
    artifact: artifactParsed.success ? artifactParsed.data : null,
    seed_span: spanParsed.success ? spanParsed.data : null,
  };
}

export class ImpactAnalysisStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Insert or update the analysis row for `(node_id, harness_id, versionRange)`.
   * Idempotent on the PK — a second write for the same range OVERWRITES the row
   * (a re-analysis of "latest" replaces the prior verdict; no duplicate rows).
   * Validates the artifact before INSERT (R2 defense-in-depth): throws on an
   * invalid artifact (a fail-loud invariant guard — the submit endpoint already
   * rejected invalid input with a 400, so this is unreachable in practice).
   */
  upsert(row: ImpactAnalysisUpsert): void {
    const validation = validateImpactArtifact(row.artifact);
    if (!validation.ok) {
      throw new Error(
        `[ImpactAnalysisStore] refusing to persist an invalid artifact: ${validation.error}`
      );
    }
    const versionRange = versionRangeKey(row.version_from, row.version_to);
    this.db
      .prepare(
        `INSERT INTO claude_update_analysis
           (node_id, harness_id, version_range, version_from, version_to,
            analyzed_at, peer_session_id, artifact_json, seed_span_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id, harness_id, version_range) DO UPDATE SET
           version_from = excluded.version_from,
           version_to = excluded.version_to,
           analyzed_at = excluded.analyzed_at,
           peer_session_id = excluded.peer_session_id,
           artifact_json = excluded.artifact_json,
           seed_span_json = excluded.seed_span_json`
      )
      .run(
        row.node_id,
        row.harness_id,
        versionRange,
        row.version_from,
        row.version_to,
        row.analyzed_at,
        row.peer_session_id,
        JSON.stringify(row.artifact),
        JSON.stringify(row.seed_span)
      );
  }

  /** The stored analysis for one `(node_id, harness_id, from→to)`, or null. */
  getByRange(
    node_id: string,
    harness_id: string,
    from: string,
    to: string
  ): ImpactAnalysisRecord | null {
    const versionRange = versionRangeKey(from, to);
    const row = this.db
      .prepare(
        `SELECT node_id, harness_id, version_range, version_from, version_to,
                analyzed_at, peer_session_id, artifact_json, seed_span_json
           FROM claude_update_analysis
          WHERE node_id = ? AND harness_id = ? AND version_range = ?`
      )
      .get(node_id, harness_id, versionRange) as ImpactAnalysisRow | null;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Record (or clear) the companion peer-session id for a range in place. The
   * orchestrator calls this once the spawned peer is known, before the peer
   * POSTs its artifact. A no-op if the row does not exist yet.
   */
  setPeerSessionId(
    node_id: string,
    harness_id: string,
    from: string,
    to: string,
    peer_session_id: string | null
  ): void {
    const versionRange = versionRangeKey(from, to);
    this.db
      .prepare(
        `UPDATE claude_update_analysis SET peer_session_id = ?
          WHERE node_id = ? AND harness_id = ? AND version_range = ?`
      )
      .run(peer_session_id, node_id, harness_id, versionRange);
  }
}
