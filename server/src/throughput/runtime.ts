// SPDX-License-Identifier: AGPL-3.0-only
import type { ThroughputSummaryService } from "./summary";

/**
 * The running throughput telemetry's request-path handles (issue #6164, A1).
 *
 * Set by the boot module (`throughput/index.ts`) when it starts and cleared
 * when it stops; the REST routes read them. Null before start, after stop and
 * when the kill switch is on, so the routes answer 503 there.
 */
let service: ThroughputSummaryService | null = null;
let ownerNamespace: string | null = null;

export function setThroughputRuntime(
  next: {
    service: ThroughputSummaryService;
    /** The node's owning namespace (from its own CLI token), or null. */
    ownerNamespace: string | null;
  } | null
): void {
  service = next?.service ?? null;
  ownerNamespace = next?.ownerNamespace ?? null;
}

export function getThroughputSummary(): ThroughputSummaryService | null {
  return service;
}

export function getThroughputOwnerNamespace(): string | null {
  return ownerNamespace;
}
