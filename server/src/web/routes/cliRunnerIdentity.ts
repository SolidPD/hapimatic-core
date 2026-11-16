// SPDX-License-Identifier: AGPL-3.0-only
import type { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { Store } from "../../store";
import {
  COND1_READABLE_AFTER_SECONDS,
  emptyRunnerIdentityCounts,
  liveSessionInput,
  REPLACED_REPORTING_WINDOW_MS,
  RunnerAttachRefusedError,
  type RunnerIdentity,
  type RunnerRefusedBody,
} from "../../sync/runnerIdentity";
import { RUNNER_IDENTITY_ENFORCE_AVAILABLE } from "../../sync/runnerIdentityMode";
import type { SyncEngine } from "../../sync/syncEngine";
import type { CliEnv } from "./cli";

/**
 * Issue #6647: the runner identity parts of the `/cli` surface, kept out of
 * `cli.ts`, which sits at its length limit (the Project Manager's R-CAP ruling
 * of 2026-11-14).
 *
 * `runnerAttachSchema` is the `runner` field of `POST /cli/sessions` (R1): the
 * id a runner minted for this attach and its pid. `.catch(undefined)` makes a
 * field of the wrong shape read as no field (R11), so it never turns the whole
 * attach into a 400, in any mode.
 */
export const runnerAttachSchema = z
  .object({
    id: z.string().min(1).max(64),
    pid: z.number().int().optional(),
  })
  .optional()
  .catch(undefined);

/**
 * R3 (Task 12): runs the attach of `POST /cli/sessions`; an attach `enforce`
 * refused becomes the route's 409 body. Any other throw goes on as before.
 */
export function attachOrRefuse<T>(
  attach: () => T
): { session: T } | { refused: RunnerRefusedBody } {
  try {
    return { session: attach() };
  } catch (error) {
    if (error instanceof RunnerAttachRefusedError) {
      return { refused: error.body };
    }
    throw error;
  }
}

/**
 * Task 9 (R10): what `GET /cli/runner-identity` returns. The lists are scoped
 * to the caller's namespace; `nodeWide` is a count only, so no id or name of
 * another namespace leaves the node. In `off` nothing is computed: the counts
 * are zero and every list is empty.
 *
 * `liveAttaches` (Task 12, V9) is #6586's count of live attaches, a read.
 * `cutOffWithoutStop` (Task 12, OR4) lists each session whose newest cut-off
 * hit a socket that the stop could not reach: `hadKey: false` is a socket with
 * no runner key (a binary from before PR1); `hadKey: true` is a keyed socket
 * that did not declare it reads the stop (a PR1 binary, F1), whose
 * `runner-superseded` emit threw, or that was already gone when the cut looked
 * it up. Such a runner may still be alive and must be
 * stopped on its node by hand (plan §8.5).
 */
export function runnerIdentityStatus(
  identity: RunnerIdentity,
  engine: SyncEngine,
  store: Store | undefined,
  namespace: string
) {
  const secondsSinceBoot = Math.max(
    0,
    Math.floor((identity.nowMs() - identity.bootedAt) / 1000)
  );
  const base = {
    mode: identity.mode,
    ...identity.resolution,
    billableMode: identity.billableMode,
    enforceAvailable: RUNNER_IDENTITY_ENFORCE_AVAILABLE,
    bootedAt: identity.bootedAt,
    secondsSinceBoot,
    cond1Readable: secondsSinceBoot >= COND1_READABLE_AFTER_SECONDS,
    columnsPresent: store?.sessions.runnerColumnsPresent() ?? false,
  };
  if (identity.mode === "off") {
    return {
      ...base,
      counts: emptyRunnerIdentityCounts(),
      unidentifiedLive: [],
      nodeWide: { unidentifiedLive: 0 },
      replacedStillReporting: [],
      replacedReporting: {
        windowMs: REPLACED_REPORTING_WINDOW_MS,
        listed: 0,
        newestReportAt: null,
      },
      liveAttaches: engine.billableLiveAttachCount(),
      cutOffWithoutStop: [],
      snapshots: [],
    };
  }
  const own = engine.getSessionsByNamespace(namespace);
  const ownIds = new Set(own.map(s => s.id));
  const replaced = identity.replacedStillReporting(id => ownIds.has(id));
  return {
    ...base,
    counts: identity.counts(),
    unidentifiedLive: identity.listUnidentifiedLive(own.map(liveSessionInput)),
    nodeWide: {
      unidentifiedLive: identity.listUnidentifiedLive(
        engine.getSessions().map(liveSessionInput)
      ).length,
    },
    // D2, P2: only replaced runners (a replaced or refused key, or no key on
    // a keyed record) that reported within the window are listed, so an empty
    // list means nothing replaced has reported for that long.
    replacedStillReporting: replaced,
    replacedReporting: {
      windowMs: REPLACED_REPORTING_WINDOW_MS,
      listed: replaced.length,
      newestReportAt: identity.newestReplacedReportAt(own => ownIds.has(own)),
    },
    liveAttaches: engine.billableLiveAttachCount(),
    cutOffWithoutStop: identity.cutOffWithoutStop(id => ownIds.has(id)),
    // Task 9a: the node's last 14 daily rows (ruling GATE).
    snapshots: identity.snapshots(),
  };
}

/**
 * Task 9: `GET /cli/runner-identity`, the readonly status of the identity
 * layer. Registered on the CLI-token app by `createCliRoutes`.
 */
export function registerCliRunnerIdentityRoute(
  app: Hono<CliEnv>,
  getSyncEngine: () => SyncEngine | null,
  store: Store | undefined
): void {
  app.get(
    "/runner-identity",
    cataloged(
      defineCapability({
        id: "session-lifecycle.runner-identity-status",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Read the runner identity layer's mode, counts since the server start, and the namespace's live processes the hub cannot name as a session's current runner.",
        whenToUse:
          "When watching a node in observe before switching it to enforce, or when checking which live sessions have an unidentified runner.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/cli/runner-identity",
        },
        auth: "cli-token",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const engine = getSyncEngine();
      const identity = engine?.getRunnerIdentity() ?? null;
      if (!engine || !identity) {
        return c.json({ error: "Not ready" }, 503);
      }
      return c.json(
        runnerIdentityStatus(identity, engine, store, c.get("namespace"))
      );
    }
  );
}
