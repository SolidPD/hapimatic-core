// SPDX-License-Identifier: AGPL-3.0-only
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SupervisedLoop } from "@hapi/protocol";
import { resolveClaudeConfigDir } from "../porter/hookRegistrationValidator";
import { sanitizeFilename } from "../web/routes/upload";

/**
 * Issue #2627 (Sub-Issue E of epic #2622): custom output-style upload +
 * cross-node distribution.
 *
 * This service owns everything about the on-disk custom output-style store and
 * its federation replication:
 *
 *  - **Persistence base** — `join(resolveClaudeConfigDir(), "output-styles")`,
 *    the EXACT base `cli/src/accounts/accountConfigDir.ts` symlinks into each
 *    account-isolated config dir (expert-review R22). It is NOT
 *    `configuration.happyHomeDir` (`~/.hapi`), which Claude Code never reads.
 *    The constructor `mkdir`s it (Task 1 / R6) so the defensive "symlinked only
 *    if present" symlink is actually created for account-bound sessions.
 *
 *  - **Resolvable identity** — Claude Code resolves a style by
 *    `frontmatter.name || filename-stem` (`loadOutputStylesDir.ts`) and keys its
 *    catalog by that name, so a custom style's identity IS its frontmatter
 *    `name`. Everything here keys by that name; the file is stored as
 *    `${sanitizeFilename(name)}.md` — deterministic on every node and
 *    traversal-safe (the stem is a shadowed fallback).
 *
 *  - **LWW + tombstones** — a `.style-sync-meta.json` sidecar (NOT a `.md`, so
 *    D's `~/.claude/output-styles/*.md` catalog ignores it) records
 *    `{ name → { updatedAt, deleted? } }`. `updatedAt` is SERVER RECEIPT TIME
 *    (never client-supplied), so two nodes uploading the same name converge by
 *    last-write-wins. A delete writes a `{ deleted: true }` tombstone that beats
 *    any older-`updatedAt` content push (offline-peer semantics, expert-review
 *    R26).
 *
 *  - **Transport** — a dedicated `output-style-sync` federation surface
 *    (push-at-upload + a reconcile digest-pull), modeled on the existing
 *    `claimSync`/`fileClaimSync` federation pattern. This preserves D's #2626
 *    by-name spawn resolution: the named file exists on every node, so D's spawn
 *    wire (which carries only the name) needs no change. Sub-Issue B's #2624
 *    channel is key→value-only and cannot carry a file body, so E builds its own
 *    (directive Transport correction).
 */

/** Sidecar filename holding LWW clocks + tombstones (not a `.md`, so it is not
 * enumerated as a style by D's catalog). */
export const OUTPUT_STYLE_SYNC_META_FILE = ".style-sync-meta.json";

/** Default cadence for the reconcile pull loop (Task 3b). */
export const OUTPUT_STYLE_RECONCILE_INTERVAL_MS = 60_000;

/** A federation peer to push to / pull from. */
export type OutputStylePeer = { id: string; url: string };

/**
 * One synced op crossing the federation channel — a content upsert
 * (`content` present) or a tombstone (`deleted: true`). `updatedAt` is the
 * originating node's server-receipt time and drives last-write-wins.
 */
export interface OutputStyleSyncOp {
  name: string;
  content?: string;
  deleted?: boolean;
  updatedAt: number;
}

/** One digest entry: LWW metadata plus the content, so a reconcile pull
 * converges in a single round-trip (styles are ≤ the upload cap). */
export interface OutputStyleDigestEntry {
  updatedAt: number;
  deleted: boolean;
  /** sha256 of the content ("" for a tombstone) — a cheap divergence check. */
  hash: string;
  /** Present for non-deleted entries; consumed by the reconcile apply. */
  content?: string;
}

export interface OutputStyleDigest {
  styles: Record<string, OutputStyleDigestEntry>;
}

interface StyleMetaEntry {
  updatedAt: number;
  deleted?: boolean;
}

interface StyleMeta {
  version: number;
  styles: Record<string, StyleMetaEntry>;
}

export interface OutputStyleSyncServiceOptions {
  /** Override the styles dir (tests). Defaults to {@link resolveOutputStylesDir}. */
  stylesDir?: string;
  /** Returns the current federation peers to push to / reconcile from. */
  resolvePeers?: () => OutputStylePeer[];
  /** This node's id, so it is excluded from its own peer list. */
  localNodeId?: string | null;
  /** Federation token used to authenticate node-to-node push/pull. */
  apiToken?: string | null;
  /** Reconcile cadence (Task 3b). Defaults to {@link OUTPUT_STYLE_RECONCILE_INTERVAL_MS}. */
  reconcileIntervalMs?: number;
  /** Injectable `fetch` (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** The canonical custom-output-style directory: the base Claude Code reads AND
 * `accountConfigDir.ts` symlinks from. */
export function resolveOutputStylesDir(): string {
  return join(resolveClaudeConfigDir(), "output-styles");
}

export class OutputStyleSyncService {
  private readonly stylesDir: string;
  private readonly resolvePeersRaw: () => OutputStylePeer[];
  private readonly localNodeId: string | null;
  private readonly apiToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly loop: SupervisedLoop;

  constructor(opts: OutputStyleSyncServiceOptions = {}) {
    this.stylesDir = opts.stylesDir ?? resolveOutputStylesDir();
    this.resolvePeersRaw = opts.resolvePeers ?? (() => []);
    this.localNodeId = opts.localNodeId ?? null;
    this.apiToken = opts.apiToken ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());

    // Task 1 / R6: ensure the styles dir exists so `accountConfigDir.ts`'s
    // defensive "symlinked only if present" symlink is actually created for
    // account-isolated sessions. mkdir is idempotent (recursive).
    this.ensureDir();

    this.loop = new SupervisedLoop({
      name: "output-style-reconcile",
      node: this.localNodeId ?? "local",
      intervalMs:
        opts.reconcileIntervalMs ?? OUTPUT_STYLE_RECONCILE_INTERVAL_MS,
      immediate: false,
      tick: () => this.reconcileOnce(),
    });
  }

  /** The resolved on-disk styles directory (also where D's catalog must read). */
  getStylesDir(): string {
    return this.stylesDir;
  }

  // ── Local store ──────────────────────────────────────────────────────────

  /** Local upsert (upload path): stamp `updatedAt = now`, write file + meta. */
  upsertLocal(name: string, content: string): { updatedAt: number } {
    this.ensureDir();
    const updatedAt = this.now();
    writeFileSync(this.fileFor(name), content, "utf-8");
    const meta = this.readMeta();
    meta.styles[name] = { updatedAt };
    this.writeMeta(meta);
    return { updatedAt };
  }

  /** Local delete (delete path): stamp `updatedAt = now`, unlink file, tombstone. */
  deleteLocal(name: string): { updatedAt: number; existed: boolean } {
    const updatedAt = this.now();
    const file = this.fileFor(name);
    let existed = false;
    try {
      if (existsSync(file)) {
        unlinkSync(file);
        existed = true;
      }
    } catch {
      // best-effort: a missing/locked file is not fatal to the tombstone
    }
    const meta = this.readMeta();
    meta.styles[name] = { updatedAt, deleted: true };
    this.writeMeta(meta);
    return { updatedAt, existed };
  }

  /**
   * Apply a remote op under last-write-wins: an op with `updatedAt` STRICTLY
   * greater than the local clock wins (ties keep the incumbent, so applying is
   * idempotent). A tombstone with a newer clock beats older content and vice
   * versa. Used by the federation receiver (Task 3) and the reconcile pull
   * (Task 3b).
   */
  applyRemote(op: OutputStyleSyncOp): { applied: boolean } {
    const meta = this.readMeta();
    const existing = meta.styles[op.name];
    if (existing && op.updatedAt <= existing.updatedAt) {
      return { applied: false };
    }
    this.ensureDir();
    const file = this.fileFor(op.name);
    if (op.deleted) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        // best-effort unlink
      }
      meta.styles[op.name] = { updatedAt: op.updatedAt, deleted: true };
    } else {
      writeFileSync(file, op.content ?? "", "utf-8");
      meta.styles[op.name] = { updatedAt: op.updatedAt };
    }
    this.writeMeta(meta);
    return { applied: true };
  }

  /** Build the reconcile digest from the meta store (content included so a
   * pull converges in one round-trip). */
  buildDigest(): OutputStyleDigest {
    const meta = this.readMeta();
    const styles: Record<string, OutputStyleDigestEntry> = {};
    for (const [name, entry] of Object.entries(meta.styles)) {
      if (entry.deleted) {
        styles[name] = { updatedAt: entry.updatedAt, deleted: true, hash: "" };
        continue;
      }
      const content = this.tryRead(this.fileFor(name));
      if (content === null) continue; // meta says present but file is gone
      styles[name] = {
        updatedAt: entry.updatedAt,
        deleted: false,
        hash: hashContent(content),
        content,
      };
    }
    return { styles };
  }

  // ── Federation transport ─────────────────────────────────────────────────

  /** Fan an op out to every peer (best-effort). Used by upload + delete. */
  async pushOp(op: OutputStyleSyncOp): Promise<void> {
    const peers = this.peers();
    if (peers.length === 0) return;
    await Promise.allSettled(peers.map(peer => this.postToPeer(peer, op)));
  }

  /** Pull each peer's digest and apply divergences under LWW (Task 3b). This is
   * the offline-peer backstop the push alone cannot provide. */
  async reconcileOnce(): Promise<void> {
    for (const peer of this.peers()) {
      try {
        const res = await this.fetchImpl(
          `${peer.url}/api/federation/output-style-digest`,
          { headers: this.authHeaders(), signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) continue;
        const digest = (await res.json()) as OutputStyleDigest;
        for (const [name, entry] of Object.entries(digest.styles ?? {})) {
          this.applyRemote({
            name,
            content: entry.content,
            deleted: entry.deleted,
            updatedAt: entry.updatedAt,
          });
        }
      } catch (err) {
        console.warn(
          `[OutputStyleSync] reconcile from ${peer.id} failed:`,
          err
        );
      }
    }
  }

  /** Start the reconcile loop (Task 3b). */
  start(): void {
    if (this.loop.getStatus() === "stopped") this.loop.start();
  }

  /** Stop the reconcile loop (graceful shutdown). */
  stop(): void {
    this.loop.stop();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private peers(): OutputStylePeer[] {
    const seen = new Set<string>();
    const out: OutputStylePeer[] = [];
    for (const peer of this.resolvePeersRaw()) {
      if (!peer?.url || !peer.id) continue;
      if (peer.id === this.localNodeId) continue; // never push to self
      if (seen.has(peer.id)) continue;
      seen.add(peer.id);
      out.push(peer);
    }
    return out;
  }

  private authHeaders(): Record<string, string> {
    return this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {};
  }

  private async postToPeer(
    peer: OutputStylePeer,
    op: OutputStyleSyncOp
  ): Promise<void> {
    try {
      const res = await this.fetchImpl(
        `${peer.url}/api/federation/output-style-sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders(),
          },
          body: JSON.stringify(op),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) {
        // A stale-binary peer lacking the receiver 404s here — degrade cleanly;
        // the reconcile pull (Task 3b) is the convergence backstop.
        console.warn(
          `[OutputStyleSync] push to ${peer.id} → HTTP ${res.status}`
        );
      }
    } catch (err) {
      console.warn(`[OutputStyleSync] push to ${peer.id} failed:`, err);
    }
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.stylesDir, { recursive: true });
    } catch (err) {
      console.warn(`[OutputStyleSync] ensureDir failed:`, err);
    }
  }

  private fileFor(name: string): string {
    return join(this.stylesDir, `${sanitizeFilename(name)}.md`);
  }

  private metaPath(): string {
    return join(this.stylesDir, OUTPUT_STYLE_SYNC_META_FILE);
  }

  private readMeta(): StyleMeta {
    const raw = this.tryRead(this.metaPath());
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Partial<StyleMeta>;
        if (parsed && typeof parsed === "object" && parsed.styles) {
          return { version: parsed.version ?? 1, styles: parsed.styles };
        }
      } catch {
        // garbled meta → start fresh (the .md files are the source of truth)
      }
    }
    return { version: 1, styles: {} };
  }

  private writeMeta(meta: StyleMeta): void {
    try {
      writeFileSync(this.metaPath(), JSON.stringify(meta, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[OutputStyleSync] writeMeta failed:`, err);
    }
  }

  private tryRead(path: string): string | null {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
