// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountMonogram } from "@hapi/protocol";
import { isAccountMonoColorId } from "@hapi/protocol";

/**
 * Per-account monogram-override store (issue #3621).
 *
 * A tiny JSON map (`accountUuid -> AccountMonogram`) persisted at
 * `<dataDir>/account-monograms.json`. Deliberately SEPARATE from the
 * token-bearing account record (`<dataDir>/accounts/<uuid>.json`) — mirrors the
 * `NicknameStore` sidecar so a monogram write can NEVER clobber a concurrent
 * token rotation. Writes are atomic (temp + rename). Stores color **ids**
 * (`"teal"`), not Tailwind classes — the node-local file must not couple to the
 * web layer's Tailwind naming. This node-local store is read by the accounts
 * route to merge `monogram` into `GET /accounts`.
 */
export class MonogramStore {
  constructor(private readonly path: string) {}

  /** Read the full map; any read/parse failure yields an empty map (never throws). */
  private read(): Record<string, AccountMonogram> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, AccountMonogram>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Sanitize a value to the `{ letter?, color? }` contract, defensively dropping
   * a blank letter and any unknown color id. Returns undefined when the result
   * carries no valid field (the "no override" / clear state).
   */
  private clean(
    value: AccountMonogram | undefined
  ): AccountMonogram | undefined {
    if (!value || typeof value !== "object") return undefined;
    const out: AccountMonogram = {};
    if (typeof value.letter === "string" && value.letter.trim() !== "") {
      out.letter = value.letter;
    }
    if (isAccountMonoColorId(value.color)) {
      out.color = value.color;
    }
    return out.letter !== undefined || out.color !== undefined
      ? out
      : undefined;
  }

  /** The monogram override for an account, or undefined when unset/empty. */
  get(uuid: string): AccountMonogram | undefined {
    return this.clean(this.read()[uuid]);
  }

  /** The full uuid -> monogram map (only non-empty, sanitized entries). */
  getAll(): Record<string, AccountMonogram> {
    const map = this.read();
    const out: Record<string, AccountMonogram> = {};
    for (const [k, v] of Object.entries(map)) {
      const cleaned = this.clean(v);
      if (cleaned) out[k] = cleaned;
    }
    return out;
  }

  /**
   * Set (or, with an empty override, clear) an account's monogram override.
   * Atomic write so a crash mid-write never corrupts the map.
   */
  set(uuid: string, monogram: AccountMonogram): void {
    const map = this.read();
    const cleaned = this.clean(monogram);
    if (!cleaned) delete map[uuid];
    else map[uuid] = cleaned;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.path);
  }
}
