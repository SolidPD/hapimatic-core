// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type { StoredMachine, VersionedUpdateResult } from "./types";
import { safeJsonParse } from "./json";
import { updateVersionedField } from "./versionedUpdates";

type DbMachineRow = {
  id: string;
  namespace: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
  metadata_version: number;
  daemon_state: string | null;
  daemon_state_version: number;
  active: number;
  active_at: number | null;
  seq: number;
};

function toStoredMachine(row: DbMachineRow): StoredMachine {
  return {
    id: row.id,
    namespace: row.namespace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: safeJsonParse(row.metadata),
    metadataVersion: row.metadata_version,
    daemonState: safeJsonParse(row.daemon_state),
    daemonStateVersion: row.daemon_state_version,
    active: row.active === 1,
    activeAt: row.active_at,
    seq: row.seq,
  };
}

export function getOrCreateMachine(
  db: Database,
  id: string,
  metadata: unknown,
  daemonState: unknown,
  namespace: string
): StoredMachine {
  const existing = db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as
    | DbMachineRow
    | undefined;
  if (existing) {
    const stored = toStoredMachine(existing);
    if (stored.namespace !== namespace) {
      throw new Error("Machine namespace mismatch"); // R4 — unchanged
    }
    // #3324 (A-D3, daemon-authoritative): re-stamp metadata on a DAEMON
    // re-register when it changed (pre-#1081 records froze at metadata_version 1
    // with no `capabilities`). Two callers reach this branch:
    //   - cli/src/daemon/run.ts:478-482 (daemon startup) passes
    //     `daemonState: initialDaemonState` — always a non-null object.
    //   - cli/src/agent/sessionFactory.ts:305-308 (`bootstrapSession`, every
    //     session launch: runClaude.ts, runAgentSession.ts, runCodex.ts,
    //     AcpIngressServer.ts) passes no daemonState, which arrives as null
    //     (cli/src/api/api.ts `?? null`; server/src/web/routes/cli.ts).
    // Only the daemon's view is authoritative — web spawns run under the
    // daemon's env — so session-launch registers never refresh. This also
    // removes the two-writer flip when a terminal-/ACP-launched session sees a
    // different PATH than the daemon.
    const isDaemonRegister = daemonState !== null && daemonState !== undefined;
    // Never refresh to a non-object: the route schema is `metadata: z.unknown()`,
    // so null/undefined/scalar can reach here. A register may only improve the
    // record — JSON.stringify(undefined) would NULL the column and
    // JSON.stringify(null) would store "null" (cache → metadata: null).
    const isObjectMetadata = typeof metadata === "object" && metadata !== null;
    if (isDaemonRegister && isObjectMetadata) {
      const incomingJson = JSON.stringify(metadata);
      if (incomingJson !== existing.metadata) {
        // R2: identical ⇒ skip. updateMachineMetadata only touches metadata +
        // metadata_version (+ updated_at/seq), never daemon_state — R3.
        const result = updateMachineMetadata(
          db,
          id,
          metadata,
          existing.metadata_version, // optimistic-concurrency expected version
          namespace
        );
        if (
          result.result === "success" ||
          result.result === "version-mismatch"
        ) {
          // success → we wrote it; version-mismatch → a concurrent daemon
          // register already wrote fresh metadata. Either way the record is now
          // current — re-read and return it.
          const refreshed = getMachine(db, id);
          if (refreshed) return refreshed;
        }
        // result === "error" (or a vanished row): fall through to returning the
        // pre-refresh `stored` — best-effort, never throw on a metadata refresh.
      }
    }
    return stored;
  }

  const now = Date.now();
  const metadataJson = JSON.stringify(metadata);
  const daemonStateJson =
    daemonState === null || daemonState === undefined
      ? null
      : JSON.stringify(daemonState);

  db.prepare(
    `
        INSERT INTO machines (
            id, namespace, created_at, updated_at,
            metadata, metadata_version,
            daemon_state, daemon_state_version,
            active, active_at, seq
        ) VALUES (
            @id, @namespace, @created_at, @updated_at,
            @metadata, 1,
            @daemon_state, 1,
            0, NULL, 0
        )
    `
  ).run({
    id,
    namespace,
    created_at: now,
    updated_at: now,
    metadata: metadataJson,
    daemon_state: daemonStateJson,
  });

  const row = getMachine(db, id);
  if (!row) {
    throw new Error("Failed to create machine");
  }
  return row;
}

export function updateMachineMetadata(
  db: Database,
  id: string,
  metadata: unknown,
  expectedVersion: number,
  namespace: string
): VersionedUpdateResult<unknown | null> {
  const now = Date.now();

  return updateVersionedField({
    db,
    table: "machines",
    id,
    namespace,
    field: "metadata",
    versionField: "metadata_version",
    expectedVersion,
    value: metadata,
    encode: value => {
      const json = JSON.stringify(value);
      return json === undefined ? null : json;
    },
    decode: safeJsonParse,
    setClauses: ["updated_at = @updated_at", "seq = seq + 1"],
    params: { updated_at: now },
  });
}

export function updateMachineDaemonState(
  db: Database,
  id: string,
  daemonState: unknown,
  expectedVersion: number,
  namespace: string
): VersionedUpdateResult<unknown | null> {
  const now = Date.now();
  const normalized = daemonState ?? null;

  return updateVersionedField({
    db,
    table: "machines",
    id,
    namespace,
    field: "daemon_state",
    versionField: "daemon_state_version",
    expectedVersion,
    value: normalized,
    encode: value => (value === null ? null : JSON.stringify(value)),
    decode: safeJsonParse,
    setClauses: [
      "updated_at = @updated_at",
      "active = 1",
      "active_at = @active_at",
      "seq = seq + 1",
    ],
    params: { updated_at: now, active_at: now },
  });
}

export function getMachine(db: Database, id: string): StoredMachine | null {
  const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as
    | DbMachineRow
    | undefined;
  return row ? toStoredMachine(row) : null;
}

export function getMachineByNamespace(
  db: Database,
  id: string,
  namespace: string
): StoredMachine | null {
  const row = db
    .prepare("SELECT * FROM machines WHERE id = ? AND namespace = ?")
    .get(id, namespace) as DbMachineRow | undefined;
  return row ? toStoredMachine(row) : null;
}

export function getMachines(db: Database): StoredMachine[] {
  const rows = db
    .prepare("SELECT * FROM machines ORDER BY updated_at DESC")
    .all() as DbMachineRow[];
  return rows.map(toStoredMachine);
}

export function getMachinesByNamespace(
  db: Database,
  namespace: string
): StoredMachine[] {
  const rows = db
    .prepare(
      "SELECT * FROM machines WHERE namespace = ? ORDER BY updated_at DESC"
    )
    .all(namespace) as DbMachineRow[];
  return rows.map(toStoredMachine);
}
