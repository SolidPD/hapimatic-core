// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `HAPImatic Session Info v1` — the standardized plain-text session block
 * (issue #4480, epic #4478). The session kebab's "Copy Session Info" entry
 * writes it to the clipboard; the builder is pure and lives in `shared/` so the
 * CLI or an agent tool can emit the identical block later.
 *
 * Format (the contract — a change to a key, its order, or a value rule is a
 * new version):
 * - Line 1 is exactly {@link SESSION_INFO_HEADER}.
 * - Then one `Key: value` line per {@link SESSION_INFO_KEYS} entry, in order.
 *   Every key is always present (a stable shape on every surface).
 * - Lines join with `\n`; no trailing newline; no markdown.
 * - Values are single-line: CR / LF / TAB become a space, whitespace runs
 *   collapse, and the value is trimmed.
 * - {@link UNKNOWN} (`—`) when the value is unknown; {@link NOT_APPLICABLE}
 *   (`n/a`) when the field does not apply.
 *
 * Allow-list (secret rule): the builder reads ONLY the fields named in
 * {@link SessionInfoSource} and {@link SessionInfoContext}. It never iterates
 * `metadata`, so a secret-bearing key on the object can never reach the text.
 * The Account value — the one field that names a credential — also passes
 * through {@link scrubTranscriptSecrets} as defense-in-depth. The scrubber is
 * deliberately NOT run over the whole block: its `sk-` rule has no left word
 * boundary, so it would mask ordinary text such as `desk-tools-and-scripts-…`
 * in a path or session name.
 */
import { displayNodeLabel } from "./federation";
import { scrubTranscriptSecrets } from "./sentryScrub";

export const SESSION_INFO_HEADER = "HAPImatic Session Info v1";

/** The v1 keys, in output order. */
export const SESSION_INFO_KEYS = [
  "Session Name",
  "Session URL",
  "HAPImatic ID",
  "HAPImatic Session ID",
  "Session Tag",
  "CLI ID",
  "Harness",
  "Launcher",
  "Account",
  "Node",
  "Status",
  "Created",
  "Last Active",
  "Path",
  "Repo",
  "Branch",
  "Worktree",
  "Linked Issue",
  "Model",
  "Effort",
  "Permission Mode",
  "Safe Mode",
  "Output Style",
  "Session Role",
  "MCP Servers (configured)",
  "Thinking Time",
  "Context",
  "Messages",
  "Started By",
  "Forked From",
  "Rate Limited",
  "HAPImatic Version",
] as const;

export type SessionInfoKey = (typeof SESSION_INFO_KEYS)[number];

/** Printed when a value is unknown (U+2014 EM DASH). */
export const UNKNOWN = "—";
/** Printed when a field does not apply to this session. */
export const NOT_APPLICABLE = "n/a";

/**
 * The allow-listed session fields the block may read. Both the full `Session`
 * record and the list card's `SessionSummary` are assignable to it, so every
 * field is optional except `id` and `active`.
 */
export type SessionInfoSource = {
  id: string;
  active: boolean;
  tag?: string | null;
  createdAt?: number;
  updatedAt?: number;
  thinkingStartedAt?: number;
  serverAccumulatedMs?: number;
  rateLimited?: { resetText: string } | null;
  permissionMode?: string;
  modelMode?: string;
  resolvedModel?: string;
  effort?: string;
  rawModel?: string;
  contextWindowTokens?: number;
  contextUsedTokens?: number;
  contextPercentage?: number;
  parentSessionId?: string | null;
  parentRelationship?: "branch" | "spawn" | null;
  metadata?: {
    path?: string;
    flavor?: string | null;
    hapiSessionTag?: string;
    worktree?: { name?: string; worktreePath?: string };
    repoIdentity?: { name?: string };
    claudeAccount?: { planLabel?: string };
    authBinding?: { kind?: string; displayIdentity?: string };
    source?: "scheduler" | "heartbeat";
    scheduleId?: string;
    safeMode?: boolean;
    sessionRole?: string;
    modelMode?: string;
    effort?: string;
    rawModel?: string;
    permissionMode?: string;
    outputStyle?: string;
    nativeModel?: string;
  } | null;
};

/** The surface's branch-row state (mirrors `SessionBranchRow`). */
export type SessionInfoBranch =
  | { kind: "name"; name: string }
  | { kind: "detached" }
  | { kind: "no-git" }
  | { kind: "unknown" };

/**
 * Display values the caller resolves (web-only label helpers, live surface
 * state, cached queries). Passing them in keeps this module free of web code.
 */
export type SessionInfoContext = {
  /** Instance origin, e.g. `https://rp1.example.ts.net`. */
  origin: string;
  /** The header title (`getSessionTitle`). */
  sessionName: string;
  /** `getCliDisplayName` (e.g. "Claude Code"). */
  harnessLabel: string;
  /** `getLauncherDisplayLabel(launcherKind)` (e.g. "SDK"). */
  launcherLabel?: string;
  /** The harness-native session id, when the harness reports one. */
  nativeId?: string;
  /** Whether the harness has a native session id at all. */
  hasNativeId: boolean;
  /** The Claude account email (`useSessionAccountEmail`, the badge's rule). */
  accountEmail?: string;
  nodeId?: string;
  nodeLabel?: string;
  nodeUrl?: string;
  branch: SessionInfoBranch;
  linkedIssue: { number: number; title: string; url: string } | null;
  /** The surface's 💬 count. */
  messageCount?: number;
  /** Enabled MCP server names; `undefined` when the status is not cached. */
  mcpEnabled?: string[];
  /** The running app version (without the `v`). */
  appVersion?: string;
  /** Tap time, `Date.now()`. */
  nowMs: number;
  /** The surface's effective thinking flag (drives Status + the live clock). */
  isThinking: boolean;
  /** True when `src` is the full session record (not a list summary). */
  isFullRecord: boolean;
};

export type SessionInfoRecord = Record<SessionInfoKey, string>;

/** HH:MM:SS — byte-identical to `web/src/utils/duration.ts` `formatDuration`. */
function formatHms(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Locale-fixed number grouping (`1,000,000`), independent of the viewer. */
function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** ISO-8601 UTC to the second; `—` for an absent or invalid timestamp. */
function formatIso(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return UNKNOWN;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** One-line value: CR/LF/TAB → space, collapse runs, trim; empty → `—`. */
function oneLine(value: string | undefined | null): string {
  if (value == null) return UNKNOWN;
  const v = String(value).replace(/\s+/g, " ").trim();
  return v === "" ? UNKNOWN : v;
}

function isClaude(flavor: string | null | undefined): boolean {
  const f = flavor?.trim().toLowerCase();
  return f === "claude" || !f;
}

function nonDefault(mode: string | undefined): string | undefined {
  return mode && mode !== "default" ? mode : undefined;
}

function accountValue(src: SessionInfoSource, ctx: SessionInfoContext): string {
  const md = src.metadata;
  let value: string | undefined;
  if (isClaude(md?.flavor) && md?.authBinding?.kind === "api-key") {
    // Issue #4568: a Claude session billed to an API key binds NO account — name
    // the key (its label, else its mask; never key material).
    const id = md.authBinding.displayIdentity || "API key";
    value = `Anthropic API · ${id} (api-key)`;
  } else if (isClaude(md?.flavor)) {
    const email = ctx.accountEmail;
    const plan = md?.claudeAccount?.planLabel;
    value = email ? (plan ? `${email} (${plan})` : email) : undefined;
  } else {
    const binding = md?.authBinding;
    const id = binding?.displayIdentity;
    value = id ? (binding?.kind ? `${id} (${binding.kind})` : id) : undefined;
  }
  return value ? scrubTranscriptSecrets(oneLine(value)) : UNKNOWN;
}

function modelValue(src: SessionInfoSource): string {
  const md = src.metadata;
  const requested =
    src.rawModel ||
    md?.rawModel ||
    nonDefault(src.modelMode) ||
    nonDefault(md?.modelMode) ||
    md?.nativeModel ||
    undefined;
  const resolved = src.resolvedModel || undefined;
  if (requested && resolved && resolved !== requested) {
    return `${requested} (resolved: ${resolved})`;
  }
  return requested ?? resolved ?? UNKNOWN;
}

function contextValue(src: SessionInfoSource): string {
  const window = src.contextWindowTokens;
  if (!window) return UNKNOWN;
  let used: number | undefined;
  if (typeof src.contextUsedTokens === "number") {
    used = src.contextUsedTokens;
  } else if (typeof src.contextPercentage === "number") {
    used = Math.round((src.contextPercentage / 100) * window);
  }
  if (used === undefined) return UNKNOWN;
  const pct =
    typeof src.contextPercentage === "number"
      ? src.contextPercentage
      : (used / window) * 100;
  return `${formatCount(used)} / ${formatCount(window)} tokens (${Math.round(pct)}%)`;
}

function branchValue(branch: SessionInfoBranch): string {
  switch (branch.kind) {
    case "name":
      return oneLine(branch.name);
    case "detached":
      return "Detached HEAD";
    case "no-git":
      return NOT_APPLICABLE;
    default:
      return UNKNOWN;
  }
}

function startedByValue(src: SessionInfoSource): string {
  const md = src.metadata;
  if (md?.source === "scheduler" || md?.source === "heartbeat") {
    return `schedule ${md.scheduleId || UNKNOWN}`;
  }
  if (src.parentRelationship === "spawn" && src.parentSessionId) {
    return `session ${src.parentSessionId}`;
  }
  return "manual";
}

/**
 * Map a session + display context to the v1 key → value record. Every value is
 * single-line and every key is present.
 */
export function deriveSessionInfoRecord(
  src: SessionInfoSource,
  ctx: SessionInfoContext
): SessionInfoRecord {
  const md = src.metadata ?? undefined;
  const full = ctx.isFullRecord;
  const thinkingMs =
    (src.serverAccumulatedMs ?? 0) +
    (ctx.isThinking && src.thinkingStartedAt != null
      ? Math.max(0, ctx.nowMs - src.thinkingStartedAt)
      : 0);
  const nodeRaw = ctx.nodeLabel ?? ctx.nodeId;
  const effort = src.effort ?? md?.effort;
  const permissionMode = src.permissionMode ?? md?.permissionMode;

  const record: SessionInfoRecord = {
    "Session Name": oneLine(ctx.sessionName),
    "Session URL": `${ctx.origin}/sessions/${encodeURIComponent(src.id)}`,
    "HAPImatic ID": `hapi-${src.id.slice(0, 8)}`,
    "HAPImatic Session ID": oneLine(src.id),
    "Session Tag": oneLine(src.tag || md?.hapiSessionTag),
    "CLI ID": ctx.hasNativeId ? oneLine(ctx.nativeId) : NOT_APPLICABLE,
    Harness: oneLine(ctx.harnessLabel),
    Launcher: isClaude(md?.flavor)
      ? oneLine(ctx.launcherLabel)
      : NOT_APPLICABLE,
    Account: accountValue(src, ctx),
    Node: nodeRaw
      ? oneLine(displayNodeLabel(nodeRaw, { url: ctx.nodeUrl }))
      : UNKNOWN,
    Status: !src.active ? "archived" : ctx.isThinking ? "thinking" : "idle",
    Created: formatIso(src.createdAt),
    "Last Active": formatIso(src.updatedAt),
    Path: oneLine(md?.worktree?.worktreePath ?? md?.path),
    Repo: oneLine(md?.repoIdentity?.name),
    Branch: branchValue(ctx.branch),
    Worktree: !md
      ? UNKNOWN
      : md.worktree
        ? md.worktree.name
          ? `yes (${oneLine(md.worktree.name)})`
          : "yes"
        : "no",
    "Linked Issue": ctx.linkedIssue
      ? oneLine(
          `#${ctx.linkedIssue.number} — ${ctx.linkedIssue.title} — ${ctx.linkedIssue.url}`
        )
      : "none",
    Model: oneLine(modelValue(src)),
    Effort: full ? oneLine(effort) : UNKNOWN,
    "Permission Mode": oneLine(permissionMode),
    // A full record with no metadata cannot say: unknown, not a confident "off".
    "Safe Mode": full && md ? (md.safeMode === true ? "on" : "off") : UNKNOWN,
    "Output Style": full ? oneLine(md?.outputStyle) : UNKNOWN,
    "Session Role": full ? oneLine(md?.sessionRole) : UNKNOWN,
    "MCP Servers (configured)": ctx.mcpEnabled
      ? ctx.mcpEnabled.length > 0
        ? oneLine([...ctx.mcpEnabled].sort().join(", "))
        : "none"
      : UNKNOWN,
    "Thinking Time": formatHms(thinkingMs),
    Context: contextValue(src),
    // The exact count behind the surface's message badge (the badge itself
    // abbreviates ≥1000 to `1k+`), ungrouped so it reads the same number.
    Messages:
      typeof ctx.messageCount === "number"
        ? String(Math.round(ctx.messageCount))
        : UNKNOWN,
    "Started By": oneLine(startedByValue(src)),
    "Forked From":
      src.parentSessionId && src.parentRelationship !== "spawn"
        ? oneLine(src.parentSessionId)
        : NOT_APPLICABLE,
    "Rate Limited": src.rateLimited
      ? oneLine(`yes (resets ${src.rateLimited.resetText})`)
      : "no",
    "HAPImatic Version": ctx.appVersion
      ? oneLine(`v${ctx.appVersion}`)
      : UNKNOWN,
  };
  return record;
}

/** Render a record as the v1 text block (header + one line per key). */
export function formatSessionInfoText(record: SessionInfoRecord): string {
  return [
    SESSION_INFO_HEADER,
    ...SESSION_INFO_KEYS.map(key => `${key}: ${record[key]}`),
  ].join("\n");
}

/** Build the `HAPImatic Session Info v1` block. Pure and synchronous. */
export function buildSessionInfoText(
  src: SessionInfoSource,
  ctx: SessionInfoContext
): string {
  return formatSessionInfoText(deriveSessionInfoRecord(src, ctx));
}
