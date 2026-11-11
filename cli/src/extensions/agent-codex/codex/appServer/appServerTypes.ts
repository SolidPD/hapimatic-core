// SPDX-License-Identifier: AGPL-3.0-only
// Ported from tiann/hapi@34f931ef5 (cli/src/codex/appServerTypes.ts), AGPL-3.0-only, with changes.
/**
 * The `codex app-server` JSON-RPC surface the #6263 transport uses. Checked
 * against `codex app-server generate-json-schema` on Codex 0.147.0, 0.166.0
 * and 0.167.0.
 */

/** `AskForApproval` string form; the schema has no `on-failure`. */
export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface InitializeParams {
  clientInfo: {
    name: string;
    title?: string;
    version: string;
  };
  capabilities: { experimentalApi: boolean } | null;
}

export interface InitializeResponse {
  userAgent?: string;
  codexHome?: string;
  [key: string]: unknown;
}

export interface ThreadStartParams {
  model?: string;
  modelProvider?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  config?: Record<string, unknown>;
  baseInstructions?: string;
  developerInstructions?: string;
}

/** Same optional fields as {@link ThreadStartParams}, plus the thread to load. */
export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
}

/** `thread/start` and `thread/resume` answer with the same shape. */
export interface ThreadResponse {
  thread: { id: string; [key: string]: unknown };
  model?: string;
  approvalPolicy?: unknown;
  sandbox?: unknown;
  [key: string]: unknown;
}

export type UserInput = { type: "text"; text: string };

/**
 * The workspace-write policy with the settings Codex derives from config.toml
 * `[sandbox_workspace_write]`. Codex fills an omitted field with its default,
 * and a `turn/start` policy replaces the thread's, so a turn must carry these
 * fields to keep the user's settings (measured on 0.167.0: a bare object
 * turned `network_access = true` off).
 */
export interface WorkspaceWritePolicy {
  type: "workspaceWrite";
  writableRoots?: string[];
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export type SandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly" }
  | WorkspaceWritePolicy;

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;
  model?: string;
}

export interface TurnStartResponse {
  turn: { id: string; status?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/** `config/read`: the effective config as seen from `cwd`. */
export interface ConfigReadParams {
  cwd?: string | null;
  includeLayers?: boolean;
}

export interface ConfigReadResponse {
  config?: unknown;
  [key: string]: unknown;
}

/** The ten server-to-client request methods on Codex 0.147.0 and 0.167.0. */
export const APP_SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/call",
  "attestation/generate",
  "account/chatgptAuthTokens/refresh",
] as const;

export type AppServerRequestMethod =
  (typeof APP_SERVER_REQUEST_METHODS)[number];

/** The `turn/start` sandbox object for a `thread/start` sandbox mode. */
export function sandboxPolicyFor(mode: SandboxMode | undefined): SandboxPolicy {
  switch (mode) {
    case "read-only":
      return { type: "readOnly" };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "workspace-write":
    default:
      return { type: "workspaceWrite" };
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(v => typeof v === "string")
    ? [...value]
    : undefined;
}

function workspaceWritePolicy(fields: {
  writableRoots: unknown;
  networkAccess: unknown;
  excludeTmpdirEnvVar: unknown;
  excludeSlashTmp: unknown;
}): WorkspaceWritePolicy {
  const policy: WorkspaceWritePolicy = { type: "workspaceWrite" };
  const roots = stringList(fields.writableRoots);
  if (roots) policy.writableRoots = roots;
  if (typeof fields.networkAccess === "boolean") {
    policy.networkAccess = fields.networkAccess;
  }
  if (typeof fields.excludeTmpdirEnvVar === "boolean") {
    policy.excludeTmpdirEnvVar = fields.excludeTmpdirEnvVar;
  }
  if (typeof fields.excludeSlashTmp === "boolean") {
    policy.excludeSlashTmp = fields.excludeSlashTmp;
  }
  return policy;
}

/**
 * The full workspace-write policy from a `thread/start` or `thread/resume`
 * reply's `sandbox`, or null when the thread loaded in another mode. Only the
 * four known fields are copied, so nothing unknown is sent back on turn/start.
 */
export function workspaceWritePolicyFromThread(
  sandbox: unknown
): WorkspaceWritePolicy | null {
  const s = asObject(sandbox);
  if (s?.type !== "workspaceWrite") return null;
  return workspaceWritePolicy({
    writableRoots: s.writableRoots,
    networkAccess: s.networkAccess,
    excludeTmpdirEnvVar: s.excludeTmpdirEnvVar,
    excludeSlashTmp: s.excludeSlashTmp,
  });
}

/**
 * The workspace-write policy from a `config/read` reply's `config`
 * (`sandbox_workspace_write`, snake_case). No such section means the user set
 * none, which is Codex's defaults. Null when `config` is not an object.
 */
export function workspaceWritePolicyFromConfig(
  config: unknown
): WorkspaceWritePolicy | null {
  const c = asObject(config);
  if (!c) return null;
  const section = asObject(c.sandbox_workspace_write);
  if (!section) return { type: "workspaceWrite" };
  return workspaceWritePolicy({
    writableRoots: section.writable_roots,
    networkAccess: section.network_access,
    excludeTmpdirEnvVar: section.exclude_tmpdir_env_var,
    excludeSlashTmp: section.exclude_slash_tmp,
  });
}
