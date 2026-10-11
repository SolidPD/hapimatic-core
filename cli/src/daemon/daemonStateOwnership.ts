// SPDX-License-Identifier: MIT
/**
 * Who owns `daemon.state.json`, as seen by a running daemon (issue #4155).
 *
 * Two daemons can end up live on one HAPI_HOME (a CLI stale cleanup used to
 * delete a live daemon's lock). Before #4155 the replaced daemon's heartbeat saw
 * the successor's pid, requested shutdown, and then fell through to overwrite the
 * successor's record; the successor later read a foreign pid and shut down too.
 *
 * The rule here: only a DIFFERENT, LIVE pid means "this daemon was replaced" — the
 * newest daemon (whose boot write asserted ownership) wins. A missing, unreadable,
 * pid-less or dead-pid record is stale and is reclaimed instead of killing the
 * live daemon. Pure: all I/O is injected. Reasons never carry a token value.
 */
import type { DaemonLocallyPersistedState } from "@/persistence";

/** This daemon's identity, compared against the on-disk record. */
export interface DaemonSelf {
  pid: number;
  httpPort: number;
  controlToken: string;
}

export type DaemonStateOwnership =
  | { kind: "own" }
  | { kind: "own-divergent"; reason: string }
  | { kind: "unowned"; reason: string }
  | { kind: "stale-foreign"; pid: number; reason: string }
  | { kind: "live-foreign"; pid: number };

/**
 * Classify the on-disk record against this daemon. `record` is untrusted JSON
 * (or `null` for a missing / unparseable file).
 */
export function classifyDaemonStateOwnership(
  record: unknown,
  self: DaemonSelf,
  isAlive: (pid: number) => boolean
): DaemonStateOwnership {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {
      kind: "unowned",
      reason: "the state file is missing or unreadable",
    };
  }
  const fields = record as Record<string, unknown>;
  const pid = fields.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return { kind: "unowned", reason: "the state file has no valid pid" };
  }
  if (pid === self.pid) {
    const differing: string[] = [];
    if (fields.httpPort !== self.httpPort) differing.push("httpPort");
    // Compared in memory only — the value is never logged or returned.
    if (fields.controlToken !== self.controlToken)
      differing.push("controlToken");
    if (differing.length === 0) return { kind: "own" };
    return {
      kind: "own-divergent",
      reason: `it names this daemon's pid but a different ${differing.join(" and ")} — another writer shares this pid number`,
    };
  }
  if (isAlive(pid)) return { kind: "live-foreign", pid };
  return {
    kind: "stale-foreign",
    pid,
    reason: `it names pid ${pid}, which is not running`,
  };
}

/** Injected collaborators for {@link createOwnStateWriter}. */
export interface OwnStateWriterDeps {
  self: DaemonSelf;
  isAlive: (pid: number) => boolean;
  /** Synchronous read of the record (`readDaemonStateSync`). */
  readState: () => unknown;
  /** The raw file write (`writeDaemonState`). */
  writeState: (state: DaemonLocallyPersistedState) => void;
  isShutdownRequested: () => boolean;
  requestShutdown: (source: "exception", message: string) => void;
  warn: (message: string) => void;
}

/** The single path for every post-boot daemon write of `daemon.state.json`. */
export interface OwnStateWriter {
  /**
   * False (after requesting shutdown) when another LIVE daemon owns the record;
   * true otherwise. Never writes and never warns except on replacement.
   */
  stillOwner(): boolean;
  /**
   * Compare-and-write: re-reads and re-classifies SYNCHRONOUSLY right before
   * writing, so no `await` separates the check from the write. Returns true iff
   * the record was written.
   */
  persist(state: DaemonLocallyPersistedState): boolean;
}

/** The pre-#4155 shutdown message, kept verbatim for journal continuity. */
export const REPLACED_DAEMON_MESSAGE =
  "A different daemon was started without killing us. We should kill ourselves.";

export function createOwnStateWriter(deps: OwnStateWriterDeps): OwnStateWriter {
  const yieldTo = (pid: number): false => {
    deps.warn(
      `daemon.state.json names another live daemon (pid ${pid}) — this daemon was replaced; shutting down without writing the state file (#4155)`
    );
    deps.requestShutdown("exception", REPLACED_DAEMON_MESSAGE);
    return false;
  };
  const classify = (): DaemonStateOwnership =>
    classifyDaemonStateOwnership(deps.readState(), deps.self, deps.isAlive);

  return {
    stillOwner(): boolean {
      const ownership = classify();
      return ownership.kind === "live-foreign" ? yieldTo(ownership.pid) : true;
    },
    persist(state: DaemonLocallyPersistedState): boolean {
      if (deps.isShutdownRequested()) return false;
      const ownership = classify();
      if (ownership.kind === "live-foreign") return yieldTo(ownership.pid);
      if (ownership.kind !== "own") {
        deps.warn(`Reclaiming daemon.state.json: ${ownership.reason} (#4155)`);
      }
      deps.writeState(state);
      return true;
    },
  };
}
