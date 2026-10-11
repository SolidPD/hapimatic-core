// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import type { WebAppEnv } from "../middleware/auth";
import type { SyncEngine } from "../../sync/syncEngine";
import type { OutputStyleSyncService } from "../../services/outputStyleSyncService";
import { BUILTIN_OUTPUT_STYLES, parseStyleFrontmatter } from "./outputStyles";
import { resetDefaultOutputStyleIfEquals } from "./preferences";

/**
 * Issue #2627 (Sub-Issue E) — custom output-style upload + delete.
 *
 * `POST /api/output-styles/upload` (Task 2, R1/R2) and
 * `DELETE /api/output-styles/:name` (Task 5, R5). Both are JWT-only surfaces:
 * they mount AFTER the auth middleware in `server.ts` (next to the catalog
 * route), so the mount POSITION is the auth mechanism (expert-review R25) — the
 * only PRE-auth output-style surface is the fed-token-gated federation receiver
 * (`federation/outputStyleSync.ts`).
 *
 * All persistence + cross-node distribution is delegated to
 * {@link OutputStyleSyncService}; these routes are the thin validation + degrade
 * layer.
 */

/** Max uploaded style size — 64 KB. A style is frontmatter + prose; the longest
 * built-in prompt is well under this. Documented in the inline error. */
export const MAX_OUTPUT_STYLE_SIZE = 64 * 1024;

/** Built-in style names are reserved (case-insensitive): a custom style with one
 * of these names would SHADOW the built-in in Claude Code's loader
 * (`allStyles[name]` is overwritten by later, user-scoped groups). */
const RESERVED_NAMES = new Set(
  BUILTIN_OUTPUT_STYLES.map(s => s.name.toLowerCase())
);

export interface OutputStyleUploadDeps {
  service: OutputStyleSyncService;
  settingsFile: string;
  getSyncEngine: () => SyncEngine | null;
}

export function createOutputStyleUploadRoutes(
  deps: OutputStyleUploadDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/output-styles/upload",
    cataloged(
      defineCapability({
        id: "model-permission.output-style-upload",
        domain: "model-permission",
        surface: "rest",
        description:
          "Upload (or replace) a named output-style definition for this node.",
        whenToUse: "When the user saves a custom output style.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/output-styles/upload",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: {
          scope: "user",
          mountedWhen: "output-style-sync-service",
        },
        probe: "skip",
      })
    ),
    async c => {
      let body: Record<string, string | File>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json(
          { error: "Invalid upload", details: "Expected multipart/form-data" },
          400
        );
      }

      const file = body["file"];
      if (!(file instanceof File)) {
        return c.json(
          {
            error: "No file",
            details: "A single `.md` file field named `file` is required",
          },
          400
        );
      }

      // R1: `.md` only.
      if (!file.name.toLowerCase().endsWith(".md")) {
        return c.json(
          {
            error: "Invalid file type",
            details: "Only .md files are accepted",
          },
          400
        );
      }

      // R1: size cap.
      if (file.size > MAX_OUTPUT_STYLE_SIZE) {
        return c.json(
          {
            error: "File too large",
            details: `Maximum size is ${MAX_OUTPUT_STYLE_SIZE / 1024} KB`,
          },
          400
        );
      }

      const content = await file.text();

      // R1: frontmatter `name` required (same parser D's catalog uses).
      const fm = parseStyleFrontmatter(content);
      if (!fm.name) {
        return c.json(
          {
            error: "Missing name",
            details: "The .md frontmatter must include a `name` field",
          },
          400
        );
      }

      // R1: reject a name colliding with a built-in (case-insensitive).
      if (RESERVED_NAMES.has(fm.name.toLowerCase())) {
        return c.json(
          {
            error: "Reserved name",
            details: `"${fm.name}" collides with a built-in style (default/Explanatory/Learning)`,
          },
          400
        );
      }

      // R2: persist locally + push to peers. Re-upload of an existing CUSTOM name
      // is an allowed overwrite (expert-review R30), not a 409.
      const { updatedAt } = deps.service.upsertLocal(fm.name, content);
      await deps.service.pushOp({ name: fm.name, content, updatedAt });

      return c.json(
        { ok: true, name: fm.name, description: fm.description ?? "" },
        200
      );
    }
  );

  app.delete(
    "/output-styles/:name",
    cataloged(
      defineCapability({
        id: "model-permission.output-style-delete",
        domain: "model-permission",
        surface: "rest",
        description: "Delete a named output style from this node.",
        whenToUse: "When the user removes a custom output style.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/output-styles/:name",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: {
          scope: "user",
          mountedWhen: "output-style-sync-service",
        },
      })
    ),
    async c => {
      const rawName = c.req.param("name");
      if (!rawName) {
        return c.json(
          { error: "Missing name", details: "A style name is required" },
          400
        );
      }

      // Traversal guard (expert-review R27): reject path separators / `..` before
      // touching the filesystem — a `:name` like `..%2f..%2fCLAUDE` (decoded to
      // `../../CLAUDE`) must not be able to unlink `~/.claude/CLAUDE.md`. The
      // service's `sanitizeFilename` also neutralizes it, but a 400 here is the
      // explicit contract.
      if (/[/\\\x00]/.test(rawName) || rawName.includes("..")) {
        return c.json(
          {
            error: "Invalid name",
            details: "Style names cannot contain path separators or '..'",
          },
          400
        );
      }

      // Never delete a built-in (case-insensitive).
      if (RESERVED_NAMES.has(rawName.toLowerCase())) {
        return c.json(
          {
            error: "Reserved name",
            details: "Built-in styles cannot be deleted",
          },
          400
        );
      }

      // R5: remove locally + propagate the deletion as an LWW tombstone.
      const { updatedAt } = deps.service.deleteLocal(rawName);
      await deps.service.pushOp({ name: rawName, deleted: true, updatedAt });

      // R5 clean degrade: the delete path OWNS the scrub — reset the default
      // preference if it named this style, and clear the name from persisted
      // session metadata so a respawn never carries the now-missing style.
      const defaultReset = await resetDefaultOutputStyleIfEquals(
        deps.settingsFile,
        rawName
      );
      const sessionsScrubbed =
        deps.getSyncEngine()?.clearOutputStyleFromSessions(rawName) ?? 0;

      return c.json(
        { ok: true, name: rawName, defaultReset, sessionsScrubbed },
        200
      );
    }
  );

  return app;
}
