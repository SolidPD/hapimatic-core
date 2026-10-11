// SPDX-License-Identifier: MIT
import { writeSync } from "node:fs";

/**
 * Scratch cell for the synchronous backoff below. `Atomics.wait` needs a
 * SharedArrayBuffer-backed Int32Array, and is permitted on the MAIN thread in
 * both Node and Bun (unlike browsers) — the portable synchronous sleep.
 */
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/** Trailing newline, written separately so a multi-MB `text` is never copied. */
const NL = Buffer.from("\n");

/** Consecutive EAGAINs to burn freely before sleeping 1ms between retries. */
const EAGAIN_FREE_SPINS = 100;

/**
 * Write `text` (plus a trailing newline, matching console.log) to a file
 * descriptor synchronously and completely — looping over partial writes and
 * retrying on EAGAIN. Unlike console.log / process.stdout.write, this GUARANTEES
 * the full payload reaches the kernel before returning, so a large machine-readable
 * payload cannot be truncated by the process exiting before an async stdout buffer
 * drains (issue #3450). `fd` defaults to stdout (1); injectable for testing.
 */
export function writeStdout(text: string, fd = 1): void {
  if (!writeAll(fd, Buffer.from(text, "utf8"))) return;
  writeAll(fd, NL);
}

/** Returns false if the pipe closed (EPIPE), true once `buf` is fully written. */
function writeAll(fd: number, buf: Buffer): boolean {
  let offset = 0;
  let eagain = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
      eagain = 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // deliberate console.log parity: an early-exiting consumer (| head,
      // | less) closes the pipe; swallow like console.log did
      // (#3450 expert review 3450-1).
      if (code === "EPIPE") return false;
      if (code !== "EAGAIN") throw err;
      // fd 1 IS non-blocking on this path: `ink` is imported at module scope
      // on every invocation (runCli -> ext/host -> registry -> ext ->
      // launcher -> launcherDispatch -> claudeRemoteLauncher ->
      // ui/ink/RemoteModeDisplay.tsx) and touching process.stdout sets
      // O_NONBLOCK on both Bun and Node, so EAGAIN is the NORMAL path for any
      // piped payload above the ~64KB pipe buffer. Spin free briefly so fast
      // consumers never sleep, then back off: bare spinning measured
      // 1,139,810 retries / 1,393ms of pegged core on Bun 1.4.1/aarch64
      // (4.5MB payload, 2s stalled reader) vs 1,694 / 70ms with this 1ms wait.
      eagain += 1;
      if (eagain > EAGAIN_FREE_SPINS) Atomics.wait(SLEEP_CELL, 0, 0, 1);
    }
  }
  return true;
}
