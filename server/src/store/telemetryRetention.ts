// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Days of raw telemetry `events` kept; older rows are pruned at every boot
 * (`TelemetryStore`). A day that starts before this cutoff may have lost some
 * or all of its events, so the aggregate-debt recovery pass leaves its stored
 * rows alone (issue #6516 IR-1).
 *
 * A leaf module with no imports, on purpose: `server/src/telemetry/executor.ts`
 * reads it, and the CLI imports the executor (`hapi selftest telemetry-worker`),
 * so the CLI's Vitest suite, which runs under Node, loads it. Importing it from
 * `telemetryStore.ts` would pull in `bun:sqlite`, which Node cannot resolve.
 */
export const TELEMETRY_EVENT_RETENTION_DAYS = 90;
