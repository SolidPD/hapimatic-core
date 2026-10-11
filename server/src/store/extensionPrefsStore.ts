// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { safeJsonParse } from "./json";
import type { StoredExtensionPref } from "./types";

// Re-export so callers may import the type from either `./types` or the store
// class file (both paths are valid — see the directive for issue #1269).
export type { StoredExtensionPref };

/** Raw `extension_prefs` row as stored (INTEGER boolean, JSON-as-TEXT config). */
type ExtensionPrefRow = {
  id: string;
  enabled: number;
  config: string | null;
  updated_at: number;
};

/**
 * SQLite-backed persistence for per-extension user preferences
 * (Sub-Issue E of Epic #1264 — Extension System Architecture).
 *
 * `extension_prefs` is the SOLE authoritative enable store for extensions. Rows
 * are keyed by the extension manifest id (e.g. "builtin.notifications-push").
 * Follows the existing store pattern: synchronous queries, `Database` in the
 * constructor. The table is created by the migration in `store/index.ts`
 * (`runMigrations`), NOT here — this class only reads and writes it.
 */
export class ExtensionPrefsStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Map a raw row to the typed pref, decoding the JSON-as-TEXT config column. */
  private rowToPref(row: ExtensionPrefRow): StoredExtensionPref {
    const parsed = safeJsonParse(row.config);
    return {
      id: row.id,
      enabled: row.enabled === 1,
      config:
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null,
      updatedAt: row.updated_at,
    };
  }

  /** Select the raw `extension_prefs` row for an id, or null when absent. */
  private getRow(id: string): ExtensionPrefRow | null {
    return this.db
      .prepare("SELECT * FROM extension_prefs WHERE id = ?")
      .get(id) as ExtensionPrefRow | null;
  }

  /**
   * Read prefs for an extension. When no row exists, returns a synthetic record
   * `{ enabled: defaultEnabled, config: null, updatedAt: 0 }` WITHOUT inserting.
   * Never returns null — callers that must DETECT row absence use `getOrNull()`.
   */
  get(id: string, defaultEnabled: boolean): StoredExtensionPref {
    const row = this.getRow(id);
    if (!row) {
      return { id, enabled: defaultEnabled, config: null, updatedAt: 0 };
    }
    return this.rowToPref(row);
  }

  /**
   * Read prefs for an extension, returning `null` when no row exists. Useful when
   * the caller needs to detect "no row" without supplying a default — e.g.
   * Sub-Issue B's `host.config.get()`, which distinguishes unset from empty.
   */
  getOrNull(id: string): StoredExtensionPref | null {
    const row = this.getRow(id);
    return row ? this.rowToPref(row) : null;
  }

  /**
   * Upsert prefs for an extension via transactional read-modify-write.
   *
   * Field semantics: an OMITTED field is preserved on an existing row; an explicit
   * `config: null` CLEARS the config column (omitted ≠ null); a partial `set` on a
   * MISSING row creates it, defaulting unspecified fields (`enabled ?? true`,
   * `config ?? null`). `updated_at` is refreshed on every write.
   *
   * A single-statement `INSERT ... ON CONFLICT ... COALESCE(excluded.X, X)` upsert
   * is deliberately NOT used: COALESCE cannot distinguish omitted-config from
   * `config: null` (both bind SQL NULL), and a partial INSERT would bind an explicit
   * NULL into `enabled INTEGER NOT NULL` (the column DEFAULT does not apply to an
   * explicitly-bound NULL). The merge is therefore resolved in JS, inside a
   * transaction so the read and the write are atomic.
   */
  set(
    id: string,
    pref: { enabled?: boolean; config?: Record<string, unknown> | null }
  ): StoredExtensionPref {
    const run = this.db.transaction((): StoredExtensionPref => {
      const existing = this.getOrNull(id);
      const now = Date.now();

      // Omitted (key absent) preserves the existing value / default.
      const enabled =
        pref.enabled !== undefined ? pref.enabled : (existing?.enabled ?? true);
      // `"config" in pref` distinguishes omitted (preserve) from explicit null (clear).
      const config: Record<string, unknown> | null =
        "config" in pref ? (pref.config ?? null) : (existing?.config ?? null);

      const enabledInt = enabled ? 1 : 0;
      const configText = config === null ? null : JSON.stringify(config);

      if (existing) {
        this.db
          .prepare(
            "UPDATE extension_prefs SET enabled = ?, config = ?, updated_at = ? WHERE id = ?"
          )
          .run(enabledInt, configText, now, id);
      } else {
        this.db
          .prepare(
            "INSERT INTO extension_prefs (id, enabled, config, updated_at) VALUES (?, ?, ?, ?)"
          )
          .run(id, enabledInt, configText, now);
      }

      return { id, enabled, config, updatedAt: now };
    });
    return run();
  }

  /** Enumerate all persisted prefs in `id` order (for the future preferences UI). */
  list(): StoredExtensionPref[] {
    const rows = this.db
      .prepare("SELECT * FROM extension_prefs ORDER BY id ASC")
      .all() as ExtensionPrefRow[];
    return rows.map(row => this.rowToPref(row));
  }

  /**
   * Delete the stored pref for an extension. This REVERTS the extension to its
   * manifest default (`defaultEnabled`) — it is NOT a data purge. A
   * `defaultEnabled: true` extension that was disabled and then removed re-enables
   * on next boot. Returns `true` if a row was deleted, `false` on a miss.
   */
  remove(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM extension_prefs WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
