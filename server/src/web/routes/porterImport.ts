// SPDX-License-Identifier: AGPL-3.0-only
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { ARCHIVE_LIMITS } from "@hapi/protocol/porter";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import {
  planImport,
  commitImport,
  toPlanSummary,
  resolveClaudeDir,
  ManifestValidationError,
  SecretDecryptionError,
  PlaintextSecretsError,
  SameFilesystemError,
  IsolatedDestUnsafeError,
  IsolatedDestReapedError,
  IsolatedDestConflictError,
  StagingExpiredError,
  RegistryDriftError,
  SymlinkedSettingsError,
  type ImportPlan,
  type ImportResult,
} from "../../porter/importArchive";
import { CommitRollbackError } from "../../porter/importArchiveErrors";
import { commitFailureStack, commitFailureText } from "../../porter/commitFs";
import { PathEscapeError } from "../../porter/archiveContainment";
import { ArchiveLimitError, TarParseError } from "../../porter/tarArchive";
import { SecretInjectionError } from "../../porter/mcpImport";
import { unknownKeepModes } from "../../porter/modeReconcile";
import { unknownExclusions } from "../../porter/commitSelection";
import {
  validateSecretOverlay,
  type SecretOverlay,
} from "../../porter/mcpRebuild";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  createPorterStagingSweeper,
  isPlanExpired,
  type PorterStagingSweeper,
} from "../../porter/porterStagingSweeper";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Configuration Porter import route (issue #2343, epic #2339 Sub D, Task 6).
 *
 * Two endpoints implementing the two-phase model (D1):
 *  - `POST /porter/import/plan`   — accept the `.tar.gz`, stage + validate +
 *    decrypt + detect conflicts, and return the reviewable {@link toPlanSummary}
 *    (R4). Writes NOTHING to `~/.claude`; only an isolated staging dir under the
 *    data dir. The full {@link ImportPlan} is retained SERVER-SIDE in an
 *    in-memory store keyed by the staging handle — a server restart between plan
 *    and commit expires the plan cleanly (its staging dir is reaped by the TTL
 *    sweep).
 *  - `POST /porter/import/commit` — accept the staging handle + per-conflict
 *    overwrite opt-ins, perform the backup-then-swap under the instance mutex
 *    (F14), and return the {@link ImportResult} including validator output.
 *
 * 🔴 The MOUNT POSITION is the auth mechanism (like `createPorterKeyRoutes`,
 * #2341): this factory applies no inline auth and MUST be mounted AFTER the
 * global JWT gate in `server.ts`.
 */

/**
 * Compressed-archive size cap. Reuses `ARCHIVE_LIMITS.maxCompressedBytes` (#2340
 * = 25 MB) rather than inventing a second limit — the same 25 MB the multipart
 * upload path uses (`upload.ts:15`, documented against the 50 MB socket body
 * limit). A real config archive is far smaller; this is the outer guard, and F9's
 * total-uncompressed / ratio / entry caps enforce inside {@link planImport}.
 */
export const MAX_ARCHIVE_BYTES = ARCHIVE_LIMITS.maxCompressedBytes;

/**
 * MIME allowlist for the `.tar.gz` container. Browsers are inconsistent about the
 * type they attach to a `.tar.gz` blob, so `application/octet-stream` and an
 * empty type are accepted only with a `.tar.gz`/`.tgz` extension (the same
 * octet-stream-plus-extension fallback `upload.ts` uses).
 */
const ALLOWED_ARCHIVE_MIME = new Set([
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/tar+gzip",
]);

function hasArchiveExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

export function isArchiveTypeAllowed(mime: string, name: string): boolean {
  if (ALLOWED_ARCHIVE_MIME.has(mime)) return true;
  if (mime === "application/octet-stream" || mime === "") {
    return hasArchiveExtension(name);
  }
  return hasArchiveExtension(name);
}

const CommitBodySchema = z.object({
  stagingHandle: z.string().min(1),
  /** Dest paths (file items) and/or MCP server names the user chose to overwrite. */
  overwrite: z.array(z.string()).optional(),
  /**
   * #3247: keys the operator DESELECTED in the pre-import confirmation screen —
   * file destPaths, hook-file destPaths, MCP server names, or `skill:<name>`.
   * #4237: `excluded` is strict. It is an opt-OUT, so an unmatched key would
   * write the item anyway; every key must be a selectable item of this plan, and
   * an unknown key is refused with 400 (`excludedUnknown`). `overwrite` stays a
   * no-op for unknown keys: it is an opt-in, so an unmatched key replaces nothing.
   */
  excluded: z.array(z.string()).optional(),
  /**
   * #3590 (K4/D9): the operator's acknowledgement of `plan.hooks.registryMissing`.
   * A NAME LIST — the commit refuses (409) unless every missing name here matches
   * the plan's, or every hook is deselected. A re-plan surfacing a NEW missing
   * name is not auto-acknowledged.
   */
  acknowledgeMissingHooks: z.array(z.string()).optional(),
  /**
   * #4146 (D14): replace a symlinked settings.json the commit refused with 409.
   * The value is the link's target EXACTLY as the 409 echoed it
   * (`symlinkedSettings.target`), not a boolean. A link re-pointed or created
   * after that refusal does not match, so it is refused again.
   */
  acknowledgeSymlinkedSettings: z.string().optional(),
  /**
   * #4129: destPaths whose current mode the operator KEPT in the plan's File
   * modes list; the commit leaves them unchanged. #4177: every path must be one
   * of this plan's File-modes rows (`plan.modeReconcile.fixes`) — an unknown
   * path is refused with 400 (`keepModesUnknown`), because an unmatched opt-out
   * would let the chmod go ahead.
   */
  keepModes: z.array(z.string()).optional(),
  /**
   * #2465 R3 — operator-confirmed marketplace sources to trust in addition to the
   * default allowlist. Only consulted when the plugin install-execution gate
   * (`HAPI_PORTER_PLUGIN_INSTALL`) is ON; ignored otherwise.
   */
  extraTrustedMarketplaces: z.array(z.string()).optional(),
  /**
   * #3546 (ADR-0006 Fork A): recipient-supplied secrets for `secretRestorable:
   * false` servers. Inner keys are the SYNTHETIC slot names (`__args_<i>__`,
   * `__url__`, an env key, a header key) — never the human label. `.trim().min(1)`
   * rejects a whitespace-only value that the inherited blank-guard (`length === 0`)
   * would otherwise pass. Semantic validation (unknown server / slot, COMPLETE
   * slot coverage) runs in the handler against the plan's manifest.
   */
  secretOverlay: z
    .record(z.string(), z.record(z.string(), z.string().trim().min(1)))
    .optional(),
});

/**
 * Map a typed import error to an HTTP status. Validation/refusal failures are
 * client errors (4xx); a filesystem-misconfiguration is a server error (5xx). An
 * archive-limit breach is 413 (payload too large).
 *
 * #3299: the isolated-destination guards are all client/DI refusals of a
 * per-request `isolatedDest` and map to 400 — RC-4 ({@link IsolatedDestUnsafeError},
 * a denylisted path), RC-6 ({@link IsolatedDestReapedError}, a TTL-reaped subtree),
 * and A7 ({@link IsolatedDestConflictError}, mutual exclusion with
 * `claudeDir`/`hostConfigPath`; 400 not 409, to keep it in the same "refused input"
 * class as the others).
 *
 * RC-5 ({@link SameFilesystemError}) is PROVENANCE-DEPENDENT and CANNOT be settled
 * here: the error carries no provenance, and it has two causes — a client-supplied
 * cross-fs `isolatedDest` (client error → 400) vs. a default-dest fs mismatch
 * (server/HAPI_HOME misconfig → 500). This function keeps the default 500; the plan
 * handler's `catch` overrides to 400 when the request supplied `isolatedDest`.
 *
 * #4246: the commit handler classifies {@link commitFailureOf}(err), not `err`, so
 * a CLEAN runCommit rollback keeps its typed cause's status (400 for a
 * {@link SecretInjectionError}) and a PARTIAL one stays 500.
 */
export function statusForError(err: unknown): 400 | 409 | 410 | 413 | 500 {
  if (err instanceof ArchiveLimitError) return 413;
  // #3590 (K4/D9): unacknowledged registry drift is a re-submittable conflict —
  // 409, not 400 (the request is well-formed; it needs acknowledgeMissingHooks).
  if (err instanceof RegistryDriftError) return 409;
  // #4146 (D14): same class — a re-submittable refusal that needs
  // acknowledgeSymlinkedSettings (thrown before runCommit's try, so never wrapped).
  if (err instanceof SymlinkedSettingsError) return 409;
  if (
    err instanceof ManifestValidationError ||
    err instanceof PlaintextSecretsError ||
    err instanceof SecretDecryptionError ||
    err instanceof SecretInjectionError ||
    err instanceof PathEscapeError ||
    err instanceof TarParseError ||
    err instanceof IsolatedDestUnsafeError ||
    err instanceof IsolatedDestReapedError ||
    err instanceof IsolatedDestConflictError
  ) {
    return 400;
  }
  if (err instanceof StagingExpiredError) return 410;
  if (err instanceof SameFilesystemError) return 500;
  return 500;
}

/**
 * #4246: what the commit handler classifies. runCommit wraps every failure inside
 * its try in a {@link CommitRollbackError}. A CLEAN rollback is classified by its
 * `cause`, one level only, so a typed refusal keeps its documented status. A
 * PARTIAL rollback (files may be inconsistent), or any other error, is classified
 * as itself.
 */
export function commitFailureOf(err: unknown): unknown {
  return err instanceof CommitRollbackError && !err.partial ? err.cause : err;
}

/**
 * #4315 (item 1, operator ruling 2026-09-28): how a failed commit is logged. A
 * 5xx, or ANY rolled-back failure (a CommitRollbackError, clean or PARTIAL),
 * logs at `error` with the ORIGINAL failure's stack — the wrap's `cause`, or the
 * thrown error itself when it has none (#4242) — so it reaches Sentry. A 4xx
 * refusal raised before runCommit's try logs at `warn` with no stack. Reads
 * `err`, not {@link commitFailureOf}(err): the unwrap would hide the rollback.
 * The status is not changed here (#4246). #5787: an errno failure's stack has
 * its fs message (which can name a backup or staged path) replaced by its code
 * + syscall; frames are kept.
 */
export function commitFailureLog(
  err: unknown,
  status: number
): { severity: "error" | "warn"; stack: string | null } {
  if (status < 500 && !(err instanceof CommitRollbackError)) {
    return { severity: "warn", stack: null };
  }
  const cause = err instanceof Error ? err.cause : undefined;
  const source = cause instanceof Error ? cause : err;
  return {
    severity: "error",
    stack: source instanceof Error ? commitFailureStack(source) : null,
  };
}

/** #4237: at most this many names go into a refusal's human-readable text. */
const ERROR_NAME_LIMIT = 20;

/**
 * #4237: the names a refusal's `error` text lists — the first
 * {@link ERROR_NAME_LIMIT}, then a count of the rest — because `excluded` has
 * no length cap. The response's array field still carries every name.
 */
function namesForError(names: readonly string[]): string {
  const shown = names.slice(0, ERROR_NAME_LIMIT).join(", ");
  const rest = names.length - ERROR_NAME_LIMIT;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

/**
 * The shared import-plan store (K6, #3446). Keyed by staging handle. ONE store
 * is constructed in `server.ts` and injected into BOTH `createPorterImportRoutes`
 * and the tokenized one-liner factories, so a plan staged by the public one-liner
 * upload leg is committable via `POST /api/porter/import/commit` (which reads
 * exactly this Map). A second Map anywhere would 410 the one-liner handle at
 * commit.
 */
export type PlanStore = Map<string, ImportPlan>;

/**
 * #3590 (K6/D7): the in-memory last-import box. `server.ts` constructs ONE and
 * injects it into BOTH `createPorterImportRoutes` (which stashes the
 * {@link ImportResult} on every successful commit) and
 * `createPorterInstalledRoutes` (which exposes it as `lastImport`). Lost on
 * server restart — a deliberate, stated limitation (`GET /porter/installed` is
 * otherwise stateless and the plan is deleted on commit).
 */
export interface PorterLastImportBox {
  current: ImportResult | null;
}

/** Input to {@link stageAndPlan}. `name`/`mime` drive the archive-type guard. */
export interface StageAndPlanInput {
  name: string;
  mime: string;
  dataDir: string;
  settingsFile: string;
  errorLogger?: ErrorLogger | null;
  claudeDir?: string;
  hostConfigPath?: string;
  accountConfigBases?: string[];
  isolatedDest?: string;
  statDev?: (path: string) => number;
}

/**
 * A guard failure is a discriminated `{ ok: false }` (the caller maps `status`
 * to an HTTP response); a `planImport` validation failure THROWS a typed error
 * that propagates to the caller's `catch` (mapped via {@link statusForError}).
 */
export type StageAndPlanOutcome =
  | { ok: true; plan: ImportPlan; summary: ReturnType<typeof toPlanSummary> }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Stage + validate an archive buffer into an {@link ImportPlan} and record it in
 * the shared {@link PlanStore} — the SINGLE plan-creation path shared by the
 * authenticated `POST /porter/import/plan` route and the public tokenized upload
 * leg (`POST /p/:token/archive`), so neither forks the plan logic (K6, #3446).
 *
 * Cheap guards first (size, then MIME/extension) → `planImport` → summary →
 * `store.set`. `planImport`'s typed throws are NOT caught here (the caller owns
 * error→status mapping, including the plan route's #3299 SameFilesystemError
 * provenance branch). #5202 (U14): the summary is built BEFORE the plan is
 * stored, and a summary that throws removes the staging dir, so a failed plan
 * leaves no stored handle and no staged bytes.
 */
export async function stageAndPlan(
  buf: Uint8Array,
  input: StageAndPlanInput,
  store: PlanStore
): Promise<StageAndPlanOutcome> {
  if (buf.byteLength > MAX_ARCHIVE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Archive too large. Maximum is ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB`,
    };
  }
  if (!isArchiveTypeAllowed(input.mime, input.name)) {
    return {
      ok: false,
      status: 400,
      error: `Archive type not allowed: ${input.mime || "(none)"}`,
    };
  }
  const plan = await planImport(buf, {
    dataDir: input.dataDir,
    settingsFile: input.settingsFile,
    claudeDir: input.claudeDir,
    hostConfigPath: input.hostConfigPath,
    isolatedDest: input.isolatedDest,
    accountConfigBases: input.accountConfigBases,
    statDev: input.statDev,
  });
  let summary: ReturnType<typeof toPlanSummary>;
  try {
    summary = toPlanSummary(plan);
  } catch (err) {
    await rm(plan.stagingDir, { recursive: true, force: true }).catch(
      (cleanupErr: unknown) =>
        input.errorLogger?.log(
          "warn",
          `[porter-import] staging cleanup failed: ${plan.stagingDir}: ${String(cleanupErr)}`,
          { category: "porter-import", source: "server" }
        )
    );
    throw err;
  }
  store.set(plan.stagingHandle, plan);
  return { ok: true, plan, summary };
}

export function createPorterImportRoutes(opts: {
  settingsFile: string;
  dataDir: string;
  errorLogger?: ErrorLogger | null;
  /**
   * K6 (#3446): the SHARED plan store, injected from `server.ts` so the one-liner
   * upload leg's staged handle is committable here. Defaults to a fresh per-factory
   * Map when omitted, keeping `porterImport.test.ts` (which omits it) unchanged.
   */
  planStore?: PlanStore;
  /**
   * #3590 (K6/D7): the SHARED last-import box, injected from `server.ts` so a
   * successful commit's {@link ImportResult} is exposed on `GET /porter/installed`.
   * Omitted (undefined) in tests that don't assert the surface.
   */
  lastImport?: PorterLastImportBox;
  /**
   * Destination overrides. Production leaves these undefined so `planImport`
   * resolves the real `~/.claude`, `~/.claude.json`, and account-config bases;
   * tests pass isolated temp paths so a commit never touches real user files.
   */
  claudeDir?: string;
  hostConfigPath?: string;
  accountConfigBases?: string[];
  /**
   * Test/DI seam (#2806 RC-5): forwarded to `planImport`'s `statDev` (the
   * filesystem device-id reader backing the same-filesystem assertion). Prod
   * leaves it undefined (byte-identical); tests inject a fake so a per-request
   * `isolatedDest` cross-filesystem rejection is deterministic (#3299 Task 3d).
   */
  statDev?: (path: string) => number;
  /**
   * #5170: the SHARED staging sweeper (plan expiry + dir reaping, on a timer),
   * built in `buildWebApp.ts`. Defaults to a timer-less sweeper over this
   * factory's own plan store, so tests that omit it are unchanged.
   */
  stagingSweeper?: PorterStagingSweeper;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // In-memory plan store, keyed by staging handle. Intentionally NOT persisted:
  // a restart between plan and commit expires the plan (its staging dir is TTL-
  // swept), matching the directive's "plan expires cleanly" contract. K6 (#3446):
  // use the injected shared store when present so the one-liner upload leg's
  // handle lands here; otherwise a fresh per-factory Map (test default).
  const planStore = opts.planStore ?? new Map<string, ImportPlan>();
  const stagingSweeper =
    opts.stagingSweeper ??
    createPorterStagingSweeper({ dataDir: opts.dataDir, planStore });

  // #3546 (ADR-0006 §Security): the commit route carries recipient secrets in its
  // body (secretOverlay), so rate-limit it like the other secret-bearing mutations
  // (apiKeys.ts #1955). Per-namespace bucket; a fresh map per factory (tests).
  const commitLimiter = createRateLimiter({ name: "porter-import-commit" });

  /**
   * POST /porter/import/plan — stage + validate, return the reviewable summary.
   */
  app.post(
    "/porter/import/plan",
    cataloged(
      defineCapability({
        id: "porter.import-plan",
        domain: "porter",
        surface: "rest",
        description:
          "Stage a dry-run import plan from an uploaded config archive and return the plan summary plus a staging handle; makes no host change yet.",
        whenToUse:
          "When the user previews what a config import would change before committing.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/porter/import/plan",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      // Expire stale plans and reap abandoned staging/backup dirs
      // opportunistically (Task 6 TTL sweep; #5170 shared sweeper).
      void stagingSweeper.sweep();

      let body: Awaited<ReturnType<typeof c.req.parseBody>>;
      try {
        body = await c.req.parseBody();
      } catch {
        return c.json({ error: "Malformed multipart body" }, 400);
      }
      const file = body["file"];
      if (!file || !(file instanceof File)) {
        return c.json(
          { error: "No archive file provided (field 'file')" },
          400
        );
      }
      if (file.size > MAX_ARCHIVE_BYTES) {
        return c.json(
          {
            error: `Archive too large. Maximum is ${MAX_ARCHIVE_BYTES / 1024 / 1024}MB`,
          },
          413
        );
      }
      if (!isArchiveTypeAllowed(file.type, file.name)) {
        return c.json(
          { error: `Archive type not allowed: ${file.type || "(none)"}` },
          400
        );
      }

      // #3299: optional per-request isolated destination. Read STRICTLY — a
      // present-but-unusable value must NEVER become `undefined`, because
      // `undefined` is the legacy path that resolves the live `~/.claude`
      // (importDestination.ts:142-149). `c.req.parseBody()` fields are
      // `string | File`, so a stray File-typed value is rejected here too.
      const isoRaw = body["isolatedDest"];
      let isolatedDest: string | undefined;
      if (isoRaw !== undefined) {
        if (typeof isoRaw !== "string" || isoRaw.trim() === "") {
          return c.json(
            { error: "isolatedDest must be a non-empty string" },
            400
          );
        }
        isolatedDest = isoRaw.trim();
        // RC-4/RC-6 test the resolve()d form, but the returned root is the
        // UNRESOLVED join(isolatedDest, ".claude") (importDestination.ts:173-176);
        // a relative value would later resolve against process.cwd() and the
        // summary would show the literal — so require an absolute path up front.
        if (!isAbsolute(isolatedDest)) {
          return c.json(
            { error: "isolatedDest must be an absolute path" },
            400
          );
        }
        // The PARENT of the live config root is not isolated — isolatedDest=$HOME
        // would yield claudeDir = the real ~/.claude under the "isolated" label.
        if (
          resolve(join(isolatedDest, ".claude")) === resolve(resolveClaudeDir())
        ) {
          return c.json(
            { error: "isolatedDest resolves to the live config dir" },
            400
          );
        }
      }

      const buf = new Uint8Array(await file.arrayBuffer());
      try {
        // K6 (#3446): stage through the SHARED store via the extracted stageAndPlan,
        // so the tokenized upload leg lands its handle in the same Map the commit
        // route reads. The size/type guards above already passed; stageAndPlan
        // re-checks them defensively (the upload leg relies on that re-check).
        const outcome = await stageAndPlan(
          buf,
          {
            name: file.name,
            mime: file.type,
            dataDir: opts.dataDir,
            settingsFile: opts.settingsFile,
            errorLogger: opts.errorLogger,
            claudeDir: opts.claudeDir,
            hostConfigPath: opts.hostConfigPath,
            isolatedDest,
            // #3299 (expert review R7/D3a): resolveImportDestination redirects ONLY
            // claudeDir/hostConfigPath (importDestination.ts:172-177); accountConfigBases
            // is resolved independently (importArchive.ts:536-537), so without this an
            // "isolated" commit would still merge MCP servers (secrets re-injected) into
            // every real per-account .claude.json (mcpImport.ts:514-520) and the #3246
            // probe would report a false `pending` for each account (visibilityProbe.ts:
            // 93-96). `[]` bypasses the `??` fallback; importMcpServers skips per-account
            // work on `length === 0`.
            accountConfigBases:
              isolatedDest !== undefined ? [] : opts.accountConfigBases,
            statDev: opts.statDev,
          },
          planStore
        );
        if (!outcome.ok)
          return c.json({ error: outcome.error }, outcome.status);
        return c.json(outcome.summary);
      } catch (err) {
        // RC-5 provenance (R4): SameFilesystemError carries no provenance, so a
        // client-supplied cross-fs isolatedDest (client error → 400) is
        // indistinguishable from a default-dest fs mismatch (server misconfig →
        // 500) inside statusForError. Branch on whether THIS request supplied
        // isolatedDest; keep statusForError's SameFilesystemError → 500 default.
        const status =
          err instanceof SameFilesystemError && isolatedDest !== undefined
            ? 400
            : statusForError(err);
        const message =
          err instanceof Error ? err.message : "Import plan failed";
        // Never surface a secret value; the typed errors are already scrubbed.
        opts.errorLogger?.log(
          status >= 500 ? "error" : "warn",
          `[porter-import] plan failed: ${message}`,
          { category: "porter-import", source: "server" }
        );
        return c.json(
          {
            error: message,
            kind:
              err instanceof ManifestValidationError
                ? err.kind
                : err instanceof Error
                  ? err.name
                  : "error",
          },
          status
        );
      }
    }
  );

  /**
   * POST /porter/import/commit — backup-then-swap the reviewed plan into place.
   */
  app.post(
    "/porter/import/commit",
    cataloged(
      defineCapability({
        id: "porter.import-commit",
        domain: "porter",
        surface: "rest",
        description:
          "Apply a previously-staged import plan to the host Claude config (skills/agents/hooks/registrations) by staging handle.",
        whenToUse:
          "When the user commits a previewed config import onto this node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/porter/import/commit",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    commitLimiter,
    async c => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "Body must be JSON" }, 400);
      }
      const parsed = CommitBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          {
            error: `Invalid commit request: ${parsed.error.issues[0]?.message}`,
          },
          400
        );
      }
      const plan = planStore.get(parsed.data.stagingHandle);
      // #5170: a plan past its own TTL is expired even before the sweeper has
      // removed it, so no commit can start on it while its staging dir is due
      // for removal.
      if (!plan || isPlanExpired(plan, Date.now())) {
        if (plan) planStore.delete(plan.stagingHandle);
        return c.json(
          { error: "Import plan not found or expired. Re-run the plan step." },
          410
        );
      }

      // #3546 (R9): validate the overlay against the plan's manifest ALL UP FRONT,
      // before any write — unknown server / a server that is unresolvable or already
      // restored (#4247) / unknown slot / incomplete slot coverage each → 400 with
      // nothing written. The returned string carries no overlay VALUE.
      const secretOverlay: SecretOverlay | undefined =
        parsed.data.secretOverlay;
      if (secretOverlay) {
        const overlayError = validateSecretOverlay(
          secretOverlay,
          plan.manifest.mcpServers,
          plan.mcpServers
        );
        if (overlayError) return c.json({ error: overlayError }, 400);
      }

      // #4177 (L2): keepModes is an opt-OUT list — an unmatched path would let
      // the chmod the caller meant to prevent go ahead. Refuse it up front,
      // naming each path; the plan stays in the store for a corrected re-submit.
      const keepUnknown = unknownKeepModes(
        plan.modeReconcile,
        parsed.data.keepModes ?? []
      );
      if (keepUnknown.length > 0) {
        return c.json(
          {
            error: `keepModes names ${keepUnknown.length} path(s) that are not File modes rows in this plan: ${keepUnknown.join(", ")}`,
            keepModesUnknown: keepUnknown,
          },
          400
        );
      }

      // #4237: `excluded` is an opt-OUT list too — an unmatched key would write
      // the item the caller meant to deselect (a hook's registration would run
      // next session). Every key must be a selectable item of this plan, the same
      // groups the summary shipped; refuse the rest up front, naming each, and keep
      // the plan in the store for a corrected re-submit.
      const excludedUnknown = unknownExclusions(
        plan,
        parsed.data.excluded ?? []
      );
      if (excludedUnknown.length > 0) {
        return c.json(
          {
            error: `excluded names ${excludedUnknown.length} key(s) that are not selectable items in this plan: ${namesForError(excludedUnknown)}`,
            excludedUnknown,
          },
          400
        );
      }

      try {
        const result = await commitImport(plan, {
          overwrite: new Set(parsed.data.overwrite ?? []),
          selection: { excluded: new Set(parsed.data.excluded ?? []) },
          acknowledgeMissingHooks: parsed.data.acknowledgeMissingHooks,
          acknowledgeSymlinkedSettings:
            parsed.data.acknowledgeSymlinkedSettings,
          keepModes: new Set(parsed.data.keepModes ?? []),
          extraTrustedMarketplaces: parsed.data.extraTrustedMarketplaces,
          secretOverlay,
        });
        // Success — the staging dir is dropped inside commitImport; forget the plan.
        // #3590 (K6/D7): stash the result so GET /porter/installed reports the last
        // import (until restart) — BEFORE deleting the plan.
        if (opts.lastImport) opts.lastImport.current = result;
        planStore.delete(plan.stagingHandle);
        return c.json(result);
      } catch (err) {
        // #4246: classify a CLEAN rollback by the typed failure it rolled back.
        // Every typed-error check below reads `failure`; the message and cause
        // reads use `err` on purpose — the body keeps the outer (rollback)
        // message, so the operator still learns it was rolled back.
        const failure = commitFailureOf(err);
        if (failure instanceof StagingExpiredError) {
          planStore.delete(plan.stagingHandle);
        }
        const status = statusForError(failure);
        // #3546 (R9 hygiene audit): `err.message` on this path NEVER contains a
        // secretOverlay VALUE. An overlaid server's SecretInjectionError is
        // soft-excluded inside rebuildMcpItems and never reaches here. The one that
        // does (a plan-approved, non-overlaid server whose slot vanished at commit)
        // embeds the server + KEY name only, and no porter module logs the merged
        // config. Overlay validation errors (returned 400 above) carry names too.
        // #5676: a malformed destination .claude.json / settings.json refusal
        // carries a fixed reason, never the parser's text (Bun echoes an
        // unquoted value). #5787: an errno failure raised before runCommit's
        // try (mkdir(backupDir)) is its code + syscall, never a backup path
        // (the handle's, or the porter-backup root a failed mkdir reports).
        const message =
          err instanceof Error
            ? commitFailureText(err, plan)
            : "Import commit failed";
        // #4177 (L4) + #4242 + #4315: a 5xx or a rolled-back failure (clean or
        // PARTIAL) logs the original failure's stack at `error` — the rollback
        // wrap's `cause`, or the thrown error itself when it was raised before
        // runCommit's try (the lock, mkdir(backupDir), setup). A 4xx refusal
        // raised before runCommit's try logs at `warn`, with no stack.
        const { severity, stack } = commitFailureLog(err, status);
        opts.errorLogger?.log(
          severity,
          `[porter-import] commit failed: ${message}`,
          { category: "porter-import", source: "server", stack }
        );
        // #3590 (K4/D9): a registry-drift refusal echoes the unacknowledged names so
        // the client can render one acknowledgement control per name (the plan stays
        // in the store — re-commit with acknowledgeMissingHooks proceeds).
        if (failure instanceof RegistryDriftError) {
          return c.json(
            { error: message, registryMissing: failure.missing },
            status
          );
        }
        // #4146 (D14): echo the link so the client can re-commit with
        // acknowledgeSymlinkedSettings = symlinkedSettings.target (plan kept).
        if (failure instanceof SymlinkedSettingsError) {
          const { linkPath, target, reason } = failure;
          return c.json(
            { error: message, symlinkedSettings: { linkPath, target, reason } },
            status
          );
        }
        return c.json({ error: message }, status);
      }
    }
  );

  return app;
}
