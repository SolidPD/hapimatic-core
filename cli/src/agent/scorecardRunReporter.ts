// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import axios from "axios";
import type { Session } from "@hapi/protocol";

import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { PROVENANCE_RELATIVE_PATH } from "@/agent/projection/materializer";

/**
 * Fire-and-forget scorecard run reporter (issue #3128 Task 5, ruling 1B-21i) —
 * the transport that turns a #3130 provenance record into a `kind:"run"`
 * scorecard row. Without it V1's "provenance runs" source has no producer.
 *
 * Called beside the two `fireSessionEnd` seams at session teardown. It reads the
 * provenance manifest the projection pipeline wrote LAST (#3130 Task 3) and POSTs
 * `{ sessionId, provenance }` to the server's `/api/scorecard/run`. The skill
 * dimension is resolved SERVER-side (KD4 telemetry join); the cli sends none.
 *
 * Contained by construction — a fault here must NEVER block or delay teardown:
 *   - No `HAPI_PROVENANCE_HOME` (native Claude / projection disabled) ⇒ skip.
 *   - Missing / unreadable manifest ⇒ skip silently (a #3130-less session is
 *     simply unscored — KD4/Task 5).
 *   - Every error is caught and logged; the POST is intentionally NOT awaited by
 *     the caller, so teardown latency is unchanged even when the server is
 *     unreachable (a short timeout bounds the dangling request).
 *
 * `HAPI_PROVENANCE_HOME` is the projection config home the daemon exposes to the
 * child (`sessionSpawner.ts`); the manifest lives at
 * `<home>/${PROVENANCE_RELATIVE_PATH}`.
 */
export async function reportScorecardRun(snapshot: Session): Promise<void> {
  try {
    const home = process.env.HAPI_PROVENANCE_HOME;
    if (!home) return; // no projection ⇒ nothing to report (native / disabled)
    const sessionId = snapshot.id;
    if (!sessionId) return;

    const manifestPath = join(home, PROVENANCE_RELATIVE_PATH);
    let provenance: unknown;
    try {
      provenance = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      return; // missing / unreadable manifest ⇒ unscored, silent (KD4)
    }

    await axios.post(
      `${configuration.serverUrl}/api/scorecard/run`,
      { sessionId, provenance },
      {
        headers: { Authorization: `Bearer ${configuration.cliApiToken}` },
        timeout: 3000,
      }
    );
  } catch (error) {
    // Fire-and-forget: teardown must never fail on a scorecard report.
    logger.warn("[scorecard] run report failed (non-fatal):", error);
  }
}
