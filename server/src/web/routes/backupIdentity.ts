// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import {
  acknowledgeBackupIdentity,
  defaultBackupIdentityPaths,
  getBackupIdentityStatus,
  revealBackupIdentityOnce,
  type BackupIdentityPaths,
} from "../../config/backupAgeIdentity";

/**
 * Per-VM backup age identity routes (issue #2507, epic #2493).
 *
 * The data layer for the admin "Backup Key" page: the authenticated user reveals
 * the VM-born backup identity exactly once, saves it, and acknowledges — after
 * which it is shredded from the VM. See `config/backupAgeIdentity.ts` for the
 * lifecycle + the custody rationale (user-held, must escape the VM before VM loss).
 *
 * 🔴 SECURITY (R3, R4):
 * - The SECRET identity crosses the wire in EXACTLY ONE place: the successful
 *   `POST /backup/identity/reveal` body. `GET /status` never carries it,
 *   `POST /acknowledge` returns nothing, and `backupAgeIdentity.ts` never logs it.
 *   `backupIdentity.test.ts` asserts `status`/post-ack responses contain no
 *   `AGE-SECRET-KEY` substring — a regression guard.
 * - 🔴 The MOUNT POSITION *is* the auth mechanism. This factory applies no inline
 *   auth; it MUST be mounted in `server.ts` AFTER the global JWT middleware
 *   (`app.use("/api/*", createAuthMiddleware(...))`), beside `createPorterKeyRoutes`.
 *   Mounting it before the gate would expose the reveal unauthenticated.
 *
 * Follows the `createPorterKeyRoutes` / `createApiKeysRoutes` factory shape.
 *
 * DISPOSITION under ADR-0005 Model C (issue #2509, ruling 4a): RETAINED — these
 * routes remain the break-glass reveal for the gateway-bearing host (its
 * `gateway-db` set stays Model A) and for pre-Model-C VMs. Model-C-enrolled
 * VMs have no pending identity (gateway-born, passphrase+KMS-wrapped), so
 * `/status` reports nothing to reveal there. See `config/backupAgeIdentity.ts`.
 */
export function createBackupIdentityRoutes(
  settingsFile: string,
  // Test-only override: production callers pass `settingsFile` alone and the
  // paths resolve under the real `~/.config/hapimatic/`. Tests inject temp paths
  // so they never read/write the developer's home dir.
  pathsOverride?: BackupIdentityPaths
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const paths = pathsOverride ?? defaultBackupIdentityPaths(settingsFile);

  // GET /backup/identity/status — non-secret status (present / revealed / recipient).
  // Mounted under /api in server.ts → GET /api/backup/identity/status.
  app.get(
    "/backup/identity/status",
    cataloged(
      defineCapability({
        id: "accounts.backup-identity-status",
        domain: "accounts",
        surface: "rest",
        description:
          "Return the non-secret status of this VM's backup age identity (present / revealed / recipient); never carries the secret key.",
        whenToUse: "When the Backup Key page loads its current state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/backup/identity/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      return c.json(await getBackupIdentityStatus(paths));
    }
  );

  // POST /backup/identity/reveal — the secret identity, once, while pending:
  //   200 { identity }  — present and not yet acknowledged (repeatable until ack)
  //   410 gone          — already acknowledged + deleted
  //   404 none          — nothing has been generated on this VM
  app.post(
    "/backup/identity/reveal",
    cataloged(
      defineCapability({
        id: "accounts.backup-identity-reveal",
        domain: "accounts",
        surface: "rest",
        description:
          "Reveal this VM's backup age identity once (repeatable until acknowledged); 410 after acknowledge, 404 when none is pending.",
        whenToUse: "When the user reveals the backup key to save it off-VM.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/backup/identity/reveal",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      const result = await revealBackupIdentityOnce(paths);
      if (result.status === "revealed") {
        return c.json({ identity: result.identity });
      }
      if (result.status === "gone") {
        return c.json(
          {
            error:
              "Backup identity has already been revealed and acknowledged; it is no longer retrievable",
          },
          410
        );
      }
      // result.status === "none"
      return c.json({ error: "No backup identity is pending on this VM" }, 404);
    }
  );

  // POST /backup/identity/acknowledge — shred the identity from the VM + persist
  // the { revealed:true, recipient } marker so it can never be re-served (R4).
  // Returns 200 { ok:true } (a JSON body, matching the apiKeys/porter mutation
  // convention) rather than a 204 — the web client's generic `request` helper
  // unconditionally parses the response body, so an empty 204 would break it.
  app.post(
    "/backup/identity/acknowledge",
    cataloged(
      defineCapability({
        id: "accounts.backup-identity-acknowledge",
        domain: "accounts",
        surface: "rest",
        description:
          "Acknowledge and shred this VM's backup identity, persisting a marker so it can never be re-served.",
        whenToUse: "When the user confirms they have saved the backup key.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/backup/identity/acknowledge",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => {
      await acknowledgeBackupIdentity(paths);
      return c.json({ ok: true });
    }
  );

  return app;
}
