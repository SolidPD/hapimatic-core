// SPDX-License-Identifier: AGPL-3.0-only
import { join } from "node:path";
import { utimes, writeFile } from "node:fs/promises";
import { WORKTREE_PORT_MIN, WORKTREE_PORT_MAX } from "@hapi/protocol";

/**
 * #3202 — worktree browser-presence producer.
 *
 * The worktree TTL idle-reaper (`cli/src/daemon/cleanupWorktreesCli.ts`
 * `findTtlCandidates` Pass 2) decides "idle" from the tmux-session count, which
 * is 0 by construction for a web-UI-only instance serving an operator's browser
 * — so it wrongly reaps live instances. This module lets the web server record
 * *browser presence* into a per-instance sidecar the out-of-process reaper stats.
 *
 * Why browser presence and not raw HTTP recency: the co-located
 * `hapimatic-wt-<port>-daemon` polls its OWN server ~4×/min (health heartbeat +
 * idle-refresh: `GET /cli/sessions`, `POST /api/auth`,
 * `GET /api/federation/all-sessions`), so ANY request-recency signal reads
 * "active forever" and degrades Pass 2 to never-reap. The daemon never opens
 * `GET /api/events`, so SSE connection presence is the browser-only
 * discriminator — this factory is wired to the `SSEManager` presence hook, which
 * fires on subscribe and on each heartbeat tick while ≥1 connection is live
 * (see `sseManager.ts` `setPresenceHook`).
 *
 * Extracted from `createWebApp` (server.ts) into its own module because server.ts
 * is at the #2077 max-lines cap (1500); wired at `SSEManager` construction in
 * index.ts. Behaviour and the sidecar contract are unchanged by that relocation.
 */

/** Filename of the per-instance browser-presence sidecar (the #3210 contract). */
export const WORKTREE_PRESENCE_SIDECAR = ".worktree-last-request";

/**
 * Build a debounced "touch the presence sidecar" hook for this instance, or
 * `null` when this is NOT a worktree instance (prod 3008 / dev 3009 must never
 * emit a sidecar — they are never TTL-reaped). `SSEManager.setPresenceHook`
 * accepts `null`, so a `null` return is a clean no-op on prod/dev.
 *
 * The sidecar lives in the per-instance DATA DIR (`config.dataDir` = `HAPI_HOME`,
 * which `scripts/hapi-worktree.sh` sets to `$HOME/.hapimatic-wt-<port>`), the SAME
 * directory the out-of-process reaper derives from the port
 * (`cli/src/daemon/worktree.ts` `tearDownWorktreeInstance`). This is load-bearing:
 * the worktree web server runs with `--working-directory="$HOME"` and never learns
 * its worktree path, so a cwd-relative sidecar would silently land in `$HOME/` and
 * the port-keyed reaper would never find it. mtime = last browser presence;
 * absent/unreadable ⇒ no presence (fail-safe toward reaping). Consumed by #3210's
 * "reaped by NEITHER sweep" integration test — do not change the sidecar path or
 * mtime semantics after landing without notifying #3210.
 */
export function createWorktreePresenceTouch(config: {
  readonly webappPort: number;
  readonly dataDir: string;
}): (() => void) | null {
  if (
    config.webappPort < WORKTREE_PORT_MIN ||
    config.webappPort > WORKTREE_PORT_MAX
  ) {
    return null;
  }
  const sidecar = join(config.dataDir, WORKTREE_PRESENCE_SIDECAR);
  // R5: debounce so presence costs ~O(1) I/O per window, not per heartbeat tick.
  // The idle window is hours, so 60s granularity is ample.
  const debounceMs = Number(process.env.HAPI_WT_PRESENCE_DEBOUNCE_MS) || 60_000;
  let lastTouchMs = 0;
  return () => {
    const now = Date.now();
    if (now - lastTouchMs < debounceMs) return;
    lastTouchMs = now; // set BEFORE the async write (burst-safe)
    const stamp = new Date(now);
    // Fire-and-forget: a producer error must NEVER surface to the SSE path.
    void utimes(sidecar, stamp, stamp).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        // First touch: create the sidecar (its mtime is set to now).
        void writeFile(sidecar, "").catch(() => {});
      }
      // Any other error is intentionally swallowed.
    });
  };
}
