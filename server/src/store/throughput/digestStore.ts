// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { DigestDetail, DigestMeta } from "@hapi/protocol";

/**
 * Stored weekly throughput digests (issue #6164, A1 — R8).
 *
 * A digest is computed ONCE per window and stored in full (markdown, the
 * complete summary JSON, the collector id and the rate cards it priced with),
 * so a later read shows exactly what was reported, even after the rollups it
 * came from were rebuilt. Written only by the fleet-job digest loop.
 */

export interface DigestRecord {
  id: string;
  createdAtMs: number;
  windowFromMs: number;
  windowToMs: number;
  headline: string;
  reportPath: string | null;
  notified: boolean;
  collector: string;
  markdown: string;
  summaryJson: string;
  rateCardIds: string[];
}

function metaOf(r: Record<string, unknown>): DigestMeta {
  return {
    id: String(r.id),
    createdAtMs: Number(r.created_at_ms),
    windowFromMs: Number(r.window_from_ms),
    windowToMs: Number(r.window_to_ms),
    headline: String(r.headline),
    reportPath: (r.report_path as string | null) ?? null,
    notified: r.notified === 1,
    collector: String(r.collector),
  };
}

export class ThroughputDigestStore {
  constructor(private readonly db: Database) {}

  insert(rec: DigestRecord): void {
    this.db
      .prepare(
        `INSERT INTO throughput_digests (
           id, created_at_ms, window_from_ms, window_to_ms, headline,
           report_path, notified, collector, markdown, summary_json,
           rate_card_ids_json
         ) VALUES (
           @id, @created, @from, @to, @headline,
           @path, @notified, @collector, @markdown, @summary, @cards
         )`
      )
      .run({
        id: rec.id,
        created: rec.createdAtMs,
        from: rec.windowFromMs,
        to: rec.windowToMs,
        headline: rec.headline,
        path: rec.reportPath,
        notified: rec.notified ? 1 : 0,
        collector: rec.collector,
        markdown: rec.markdown,
        summary: rec.summaryJson,
        cards: JSON.stringify(rec.rateCardIds),
      });
  }

  /** Record that the digest's notification was delivered. */
  markNotified(id: string): void {
    this.db
      .prepare("UPDATE throughput_digests SET notified = 1 WHERE id = ?")
      .run(id);
  }

  /** Newest first, without the large columns. */
  list(limit: number): DigestMeta[] {
    return (
      this.db
        .prepare(
          `SELECT id, created_at_ms, window_from_ms, window_to_ms, headline,
                  report_path, notified, collector
             FROM throughput_digests
            ORDER BY created_at_ms DESC LIMIT ?`
        )
        .all(limit) as Array<Record<string, unknown>>
    ).map(metaOf);
  }

  get(id: string): DigestDetail | null {
    const row = this.db
      .prepare("SELECT * FROM throughput_digests WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    let summary: unknown = null;
    try {
      summary = JSON.parse(String(row.summary_json));
    } catch {
      summary = null;
    }
    return { ...metaOf(row), markdown: String(row.markdown), summary };
  }

  /** The digest already stored for this exact window, if any. */
  findByWindow(fromMs: number, toMs: number): DigestMeta | null {
    const row = this.db
      .prepare(
        `SELECT id, created_at_ms, window_from_ms, window_to_ms, headline,
                report_path, notified, collector
           FROM throughput_digests
          WHERE window_from_ms = ? AND window_to_ms = ?
          ORDER BY created_at_ms DESC LIMIT 1`
      )
      .get(fromMs, toMs) as Record<string, unknown> | undefined;
    return row ? metaOf(row) : null;
  }

  /** Delete digests created before `beforeMs`. */
  pruneBefore(beforeMs: number): number {
    return this.db
      .prepare("DELETE FROM throughput_digests WHERE created_at_ms < ?")
      .run(beforeMs).changes;
  }
}
