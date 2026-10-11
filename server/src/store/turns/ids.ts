// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UUIDv7 id helper for the per-turn telemetry schema (issue #1663, epic #1662).
 *
 * Every row inserted into `turns` / `turn_events` / `timelog_adjustments` /
 * `rate_cards` mints its `id` here. UUIDv7 is globally unique AND time-ordered
 * (the leading 48 bits are a millisecond Unix timestamp), which buys two
 * properties the federation telemetry core needs:
 *
 *   1. **Index locality** — time-ordered ids cluster newly-inserted rows at the
 *      right edge of the primary-key B-tree, so high-volume turn writes don't
 *      scatter page writes the way random v4 ids do.
 *   2. **Coordination-free federation merges** — every node mints ids
 *      independently; collision probability is negligible and time-ordering is
 *      preserved across nodes, so cross-node aggregation (Sub L) never needs a
 *      shared sequence or a merge-time renumber.
 *
 * All other stores mint v4 ids via `randomUUID()`; this is the single v7
 * indirection point so the helper can be swapped or mocked in tests.
 */
export function newUuidV7(): string {
  return Bun.randomUUIDv7();
}
