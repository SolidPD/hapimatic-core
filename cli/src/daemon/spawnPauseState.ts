// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Daemon-global spawn-quiesce flag (issue #1774, Sub E of epic #1769, Task 10 /
 * R9 / KD-2).
 *
 * The self-update flow (running in the SERVER process) POSTs
 * `/spawn-paused {paused:true}` to this daemon's control server right before it
 * flips the harness symlink, and `{paused:false}` in its `finally`. While paused,
 * the spawn gate (`sessionSpawner.ts`) rejects new spawns with
 * `code:"spawn_paused"` so a fresh `claude` cannot fork mid-symlink-swap — the
 * narrow spawn race the native installer already makes small.
 *
 * INERT BY DEFAULT: `paused` starts `false`, so the gate's pause branch is never
 * taken unless an update actively pauses — behavior on the hot spawn path is
 * byte-identical to pre-#1774. Module-scope singleton (the daemon is ONE process;
 * the control server and the spawn gate share this import) — mirrors the existing
 * module-scope spawn rate-limit state in `sessionSpawner.ts`.
 */

let paused = false;

/** True iff spawning is currently quiesced (a harness self-update is flipping
 *  the symlink). Read by the spawn gate. */
export function getSpawnPaused(): boolean {
  return paused;
}

/** Set the spawn-quiesce flag. Called by the control server's `/spawn-paused`
 *  endpoint on behalf of the self-update flow. */
export function setSpawnPaused(next: boolean): void {
  paused = next;
}
