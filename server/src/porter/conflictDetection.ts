// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Conflict detection for the Configuration Porter import path (issue #2343,
 * epic #2339 Sub D, R3 / R4, Task 4 / D4 / D5).
 *
 * 🔴 The two load-bearing decisions this module encodes:
 *  - D5 — compare by CONTENT HASH, so a byte-identical re-import is a no-op
 *    (`kind: "exists"`) rather than a conflict wall. #2345's dogfood pass re-runs
 *    imports; an idempotent path is what makes that usable.
 *  - D4 — the default resolution is SKIP, never overwrite. R3 ("intact unless the
 *    conflict is explicitly resolved") means a differing destination
 *    (`kind: "differs"`) is preserved unless the commit call carries an explicit
 *    per-item overwrite opt-in. This module only DETECTS; the commit path applies
 *    the skip/overwrite decision.
 *
 * The primitives here are reused by two writers: the file-tree merge (skills,
 * agents, commands, rules, output-styles, CLAUDE.md, hook files) and the
 * key-wise `settings.json` / `~/.claude.json` merges — so "same content is a
 * no-op, different content is a conflict" is decided in exactly one place.
 */

export type ConflictKind = "exists" | "differs";

/**
 * One detected collision. `destPath` is the absolute destination file path, or
 * `"<file>#<key>"` for a keyed (settings / MCP-server) collision.
 *  - `kind: "exists"`  → destination present AND byte-identical (the content is an
 *    idempotent no-op; the commit may still add the archive's execute bit —
 *    #4129, ./modeReconcile).
 *  - `kind: "differs"` → destination present with DIFFERENT content (a real
 *    conflict; default resolution skip preserves the user's version).
 */
export interface Conflict {
  destPath: string;
  kind: ConflictKind;
  incomingHash: string;
  existingHash: string;
}

/** A file staged for import: its destination path and incoming bytes. */
export interface StagedFileItem {
  destPath: string;
  content: Buffer;
}

/** SHA-256 hex of the content — the identity used for the no-op-vs-conflict call. */
export function hashContent(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Classify one destination given the incoming hash and the existing hash (or
 * `null` when the destination is absent). Returns `null` for an absent
 * destination (no conflict — the item will simply be written), an `"exists"`
 * Conflict when the hashes match (idempotent no-op), or a `"differs"` Conflict
 * when they diverge (a real conflict). Pure.
 */
export function classifyConflict(
  destPath: string,
  incomingHash: string,
  existingHash: string | null
): Conflict | null {
  if (existingHash === null) return null;
  return {
    destPath,
    kind: incomingHash === existingHash ? "exists" : "differs",
    incomingHash,
    existingHash,
  };
}

/** Read a file and return its content hash, or `null` if it does not exist. */
async function existingFileHash(path: string): Promise<string | null> {
  try {
    return hashContent(await readFile(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Detect conflicts for a set of file-tree items by reading each destination and
 * comparing content hashes. Absent destinations produce no conflict.
 */
export async function detectFileConflicts(
  items: readonly StagedFileItem[]
): Promise<Conflict[]> {
  const conflicts: Conflict[] = [];
  for (const item of items) {
    const incomingHash = hashContent(item.content);
    const existingHash = await existingFileHash(item.destPath);
    const c = classifyConflict(item.destPath, incomingHash, existingHash);
    if (c) conflicts.push(c);
  }
  return conflicts;
}

/**
 * Detect key-wise conflicts for a bounded settings/JSON merge. For each incoming
 * top-level key, compares the canonicalised (stable-key-order) JSON of the
 * incoming value against the existing value. A key absent from `existing`
 * produces no conflict (it will be added); a key whose value is byte-identical is
 * an `"exists"` no-op; a key whose value differs is a `"differs"` conflict. The
 * conflict `destPath` is `"<file>#<key>"` so the summary names the exact key.
 *
 * This is what makes a whole-file `settings.json` (or `~/.claude.json`) write
 * unnecessary — the merge preserves every un-imported key, and only the keys the
 * archive actually carries are candidates for a conflict.
 */
export function detectKeyedConflicts(
  filePath: string,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown>
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const key of Object.keys(incoming)) {
    if (!(key in existing)) continue; // new key — additive, no conflict
    const incomingHash = hashContent(stableStringify(incoming[key]));
    const existingHash = hashContent(stableStringify(existing[key]));
    const c = classifyConflict(
      `${filePath}#${key}`,
      incomingHash,
      existingHash
    );
    if (c) conflicts.push(c);
  }
  return conflicts;
}

/**
 * Deterministic JSON serialization with sorted object keys, so two structurally
 * equal values hash identically regardless of key insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
