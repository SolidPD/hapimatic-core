// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Issue #6324: the rule that sets an archived session back to `running` when a
 * daemon-started wrapper attaches to it, and the console line that reports it.
 * Pure: no state, no I/O, and no import, so it cannot reach runner identity.
 */

type Metadata = Record<string, unknown>;

function isMetadata(value: unknown): value is Metadata {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What the attach stores for an existing row, or null when it stores nothing.
 *
 * The outgoing wrapper archives the row as it exits; the replacing wrapper's
 * registration carries `running` and its own pid, which the attach of an
 * existing row used to discard. Only a daemon-started attach sets the row back
 * (runner identity's own sanction, #6647): a `hapi` typed in a session's shell
 * inherits the session's tag and must not take it over. A row that already
 * reads `running` is left alone, so an ordinary attach writes nothing.
 */
export function attachedMetadata(
  stored: unknown,
  registration: unknown,
  now: number
): Metadata | null {
  if (!isMetadata(stored) || !isMetadata(registration)) return null;
  if (registration.lifecycleState !== "running") return null;
  if (registration.startedBy !== "daemon") return null;
  if (stored.lifecycleState === "running") return null;
  const { archivedBy: _by, archiveReason: _reason, ...kept } = stored;
  return {
    ...kept,
    lifecycleState: "running",
    lifecycleStateSince: now,
    ...(typeof registration.hostPid === "number"
      ? { hostPid: registration.hostPid }
      : {}),
  };
}

/**
 * The console line for a row whose stored state was `archived` (the evidence
 * #6121 is read from), else null. It names the session, who archived it and
 * when: never the archive reason, and never a runner id or key.
 */
export function erasedArchiveLine(
  sessionId: string,
  stored: unknown
): string | null {
  if (!isMetadata(stored) || stored.lifecycleState !== "archived") return null;
  const by =
    typeof stored.archivedBy === "string"
      ? stored.archivedBy.replace(/[^\w.-]+/g, "_").slice(0, 40)
      : "";
  const since = stored.lifecycleStateSince;
  const at = new Date(typeof since === "number" ? since : NaN);
  const when = Number.isNaN(at.getTime()) ? "unknown" : at.toISOString();
  return `[Store] session attach reset an archived state: session=${sessionId} archivedBy=${by || "unknown"} archivedAt=${when}`;
}
