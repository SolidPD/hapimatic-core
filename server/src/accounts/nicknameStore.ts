// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Per-account nickname store (epic #1855 follow-up).
 *
 * A tiny JSON map (`accountUuid -> nickname`) persisted at
 * `<dataDir>/account-nicknames.json`. Deliberately SEPARATE from the
 * token-bearing account record (`<dataDir>/accounts/<uuid>.json`, written by
 * Claude Code's token refresh + Hapimatic's capture) so a nickname write can
 * NEVER clobber a concurrent token rotation. Writes are atomic (temp + rename).
 * This node-local store is read by UsageService to populate `AccountUsage.nickname`.
 */
export class NicknameStore {
  constructor(private readonly path: string) {}

  /** Read the full map; any read/parse failure yields an empty map (never throws). */
  private read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** The nickname for an account, or undefined when unset/blank. */
  get(uuid: string): string | undefined {
    const v = this.read()[uuid];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  }

  /** The full uuid -> nickname map (only non-blank entries). */
  getAll(): Record<string, string> {
    const map = this.read();
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "string" && v.trim() !== "") out[k] = v;
    }
    return out;
  }

  /**
   * Set (or, with a blank value, clear) an account's nickname. Atomic write so a
   * crash mid-write never corrupts the map.
   */
  set(uuid: string, nickname: string): void {
    const map = this.read();
    const trimmed = nickname.trim();
    if (trimmed === "") delete map[uuid];
    else map[uuid] = trimmed;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.path);
  }
}
