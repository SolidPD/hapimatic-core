// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Client-facing Configuration Porter types (issue #2344, epic #2339 Sub E).
 * Backs the Admin → Configuration page's four data surfaces.
 *
 * SHARED, not mirrored (#5601): the import review's wire contract — the plan
 * summary ({@link ImportPlanSummary}), the commit result ({@link ImportResult})
 * and every shape they reference — is declared once in `@hapi/protocol/porter`
 * (`shared/src/porter/importWire.ts`) and re-exported below, so the server and
 * the web compile against one definition. Fields an older server omits stay
 * optional there; keep the `?? []` guards that read them.
 *
 * :warning: MONOREPO-BOUNDARY MIRROR for the rest. `web/` may import only from
 * `@hapi/protocol` (shared), never from `server/`. The shapes still declared in
 * this file are route-level responses not yet in the shared package, MIRRORED
 * field-for-field; when the server shape changes, this file MUST change in
 * lockstep. Source-of-truth anchors:
 *
 *   - `InstalledConfigResponse`, `PorterContentResponse`
 *       → `server/src/web/routes/porterInstalled.ts`
 *   - `RegisteredHook` → `server/src/porter/hookRegistrationValidator.ts`
 *   - `PorterRecipientResponse` → `server/src/web/routes/porterKey.ts`
 *   - `SymlinkedSettingsRefusal` → the commit route's 409 echo in
 *       `server/src/web/routes/porterImport.ts`
 *   - `PorterImportPlanOptions`, `SecretOverlay` — request-side; consumed by
 *       `client.planPorterImport` / the commit call
 */
import type {
  ImportPlanSummary,
  ImportResult,
  PorterTokenResponse,
  PorterTokenState,
  PorterTokenStatus as PorterTokenStatusBase,
  SymlinkedSettingsReason,
} from "@hapi/protocol/porter";

// #5601: the import review's wire shapes, shared with the server.
export type {
  AccountVisibility,
  Conflict,
  ConflictKind,
  DimensionParity,
  ExecutableScriptReview,
  FailedRecord,
  HookRegistrationValidationResult,
  ImportGroups,
  ImportParity,
  ImportPlanSummary,
  ImportResult,
  IndependentHook,
  InstalledPluginRecord,
  MarketplaceOutcome,
  McpExclusion,
  McpFileMergeResult,
  McpImportResult,
  MergedHookRegistration,
  ModeCorrection,
  ModePreviewFix,
  ModePreviewSkip,
  ModeReconcilePreview,
  ModeSkip,
  PlannedItemKind,
  PlannedMcpServer,
  PlannedMcpServerReview,
  PluginInstallResult,
  ReAuthRecord,
  ScriptPreview,
  SkillGroup,
  SkippedPluginRecord,
  VersionDriftRecord,
} from "@hapi/protocol/porter";

/**
 * #3446 (K1) — the tokenized one-liner export contract. `PorterTokenResponse`
 * and `PorterTokenState` are genuinely shared (no server-only shapes), so they
 * are IMPORTED from `@hapi/protocol/porter` and re-exported rather than mirrored.
 * `PorterTokenStatus` carries the staged plan summary; the shared base is
 * generic over that payload, so the web instantiates it with the shared
 * {@link ImportPlanSummary}. B (#3447) fills `fetchUrlPowerShell`.
 */
export type { PorterTokenResponse, PorterTokenState };
export type PorterTokenStatus = PorterTokenStatusBase<ImportPlanSummary>;

/**
 * #3299: per-request options for the import PLAN call — the request-side companion
 * to the shared {@link ImportPlanSummary}. Request-side only, with no server
 * type; it is consumed by `client.planPorterImport` and threaded through
 * `usePorterImport`.
 */
export interface PorterImportPlanOptions {
  /**
   * Same-machine isolation (#2806/#3299): redirect the import under
   * `<isolatedDest>/.claude` instead of the live `~/.claude`. Absolute path;
   * denylisted subtrees (`/tmp`, `~/.config`, porter-staging/backup) are rejected
   * by the server (RC-4/RC-6). Omit for the default (live) destination.
   */
  isolatedDest?: string;
}

/**
 * #3546 (ADR-0006 Fork A): recipient-supplied secrets carried ONCE in the commit
 * body for `secretRestorable: false` servers — `{ [serverName]: { [slotName]:
 * value } }`. Inner keys are the SYNTHETIC slot names (`__args_<i>__`, `__url__`,
 * an env key, a header key) — never the human display label. Request-side only;
 * mirrors the server `SecretOverlay` (`server/src/porter/mcpRebuild.ts`). Held in
 * memory only; never persisted client-side.
 */
export type SecretOverlay = Record<string, Record<string, string>>;

/** `GET /api/porter/recipient` — the instance's public recipient + export affordances. */
export interface PorterRecipientResponse {
  /** Public age recipient (`age1…`). Never the secret identity. */
  recipient: string;
  schemaVersion: number;
  /**
   * #3245: the script-driven, secrets-free export — a self-contained shell
   * script the user runs DIRECTLY on the source machine (no Claude/LLM step, no
   * recipient, no secrets). Built server-side (`buildExportScript`, #3245); the
   * DEFAULT export affordance. Displayed verbatim; NEVER rebuilt client-side.
   */
  script: string;
  /**
   * Server-derived versioned download filename for `script` (e.g.
   * `hapimatic-config-export-v1.0.1049.sh`). Set unconditionally by the server
   * (`porterKey.ts:137`) and consumed by the client verbatim — never rebuilt
   * client-side. Single-sourced server-side so the filename always matches the
   * version stamped in the script's own banner. Because the web bundle is served
   * by the same server build, the only way this is absent on the wire is a dev
   * vite-against-an-older-server session; the client treats that as a no-op
   * Download rather than saving under an unversioned name (issue #3381).
   */
  scriptFilename: string;
  /**
   * Fully-rendered extraction prompt, built server-side (`buildExtractionPrompt`,
   * #2342). Displayed verbatim; NEVER rebuilt client-side (directive D3). #3245
   * DEMOTED this to the advanced/opt-in "include secrets (LLM-assisted)" path —
   * preserved (not deleted) so the deferred credential-custody work (#2339) has a
   * base and no capability is lost.
   */
  prompt: string;
}

/** One registered hook, flattened to (event, command, matcher?). */
export interface RegisteredHook {
  event: string;
  command: string;
  matcher?: string;
}

/** `GET /api/porter/installed` — the currently-installed config read surface. */
export interface InstalledConfigResponse {
  claudeDir: string;
  skills: string[];
  agents: string[];
  hooks: {
    /** Hook script files present on disk. */
    files: string[];
    /** Hook registrations declared in settings.json. */
    registrations: RegisteredHook[];
    /** Files on disk with no matching registration (dead code). */
    orphanFiles: string[];
    /** Registrations whose referenced script does not exist (dead hook). */
    orphanRegistrations: string[];
  };
  plugins: {
    marketplaces: { name: string; source: string }[];
    plugins: { name: string; marketplace?: string; version?: string }[];
  };
  /**
   * #3590 (K6/D7): the last import's {@link ImportResult} (incl. `parity`) — the
   * JSON "CLI equivalent" of the commit response. In-memory server-side: `null`
   * on a fresh server and after any restart.
   */
  lastImport?: ImportResult | null;
}

/**
 * `GET /api/porter/content?dimension&name` — one installed file's text plus its
 * exact absolute host path (issue #3116). MIRROR of the server's inline response
 * in `server/src/web/routes/porterInstalled.ts`; keep in lockstep.
 */
export interface PorterContentResponse {
  /** Absolute host path of the resolved file (the copyable path, R2). */
  path: string;
  /** File text, or "" when `truncated`/`binary`. */
  content: string;
  /** Set when the file exceeded the ~1 MB preview cap (content is ""). */
  truncated?: boolean;
  /** Set when the file is binary (NUL byte detected; content is ""). */
  binary?: boolean;
  /** Byte size, present when `truncated`. */
  size?: number;
}

/**
 * #4146 (D14) / #4277: the `symlinkedSettings` echo of a commit refused with 409
 * because the destination settings.json is a link the merge must not write
 * through. Re-committing with `acknowledgeSymlinkedSettings` set to `target`,
 * byte-exact, replaces the link, provided the link still reads `target` and the
 * selection still merges settings.json. MIRROR of the echo built in
 * `server/src/web/routes/porterImport.ts` from `SymlinkedSettingsError`;
 * `reason` is the shared `SymlinkedSettingsReason` (`@hapi/protocol/porter`,
 * #4288) the server error uses, so the two cannot drift.
 */
export interface SymlinkedSettingsRefusal {
  linkPath: string;
  target: string;
  reason: SymlinkedSettingsReason;
}
