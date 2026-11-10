// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed session / worktree / schedule tools for the injected hapi MCP server
 * (issue #3842, epic #4403 member C — authorization path (i)).
 *
 * Every tool here is a THIN WRAPPER over `hapi_call` (R3): its handler validates
 * the arguments, builds one `{ method, path, body?, query? }` request and sends it
 * through `createCapabilityTools().typedCall`, which posts it to
 * `POST /api/capabilities/call`. The server's tier gate (`isEntryInvocable`) is the
 * single authority (R4); each wrapped `mutating` entry runs only because it is
 * promoted in `PROMOTED_ENTRY_IDS`. The tools hold no tier or policy logic, and
 * the refusals that matter (self-permission R6, the caller-mode floor R8) live in
 * the server routes, where raw `hapi_call` meets them too.
 *
 * Two schemas per tool (Task 5): `inputSchema` is what `startHappyServer`
 * registers, and the MCP SDK validates it before the handler with its own string
 * error, so it carries only types and enums. The refinements (every id segment
 * checked with `isUnsafePathSegment`, the self-session refusal) run in
 * `typedCall`, which returns a structured `{ ok: false, code, field, error }`.
 *
 * Worktrees: a worktree is created by `spawn_session` with
 * `sessionType: "worktree"`. Removal is `remove_worktree` (#4450, below): the one
 * tool that does NOT go through `hapi_call`, because its route is `destructive`
 * and operator-only, which the invoker always refuses. It posts to that route
 * directly (`createCapabilityTools().postDirect`), which checks the caller.
 */
import { z } from "zod";
import { type EffortLevel } from "@hapi/protocol/effort";
import {
  ExistingBranchSchema,
  type ExistingBranch,
} from "@hapi/protocol/gitBranches";
import {
  PERMISSION_MODES,
  isYoloEquivalentMode,
  type PermissionMode,
} from "@hapi/protocol/modes";
import { EffortLevelSchema } from "@hapi/protocol/schemas";
import { McpSetSchema, type McpSet } from "@hapi/protocol";

/** The request a typed tool hands to `call()` — the `hapi_call` input. */
export type TypedCallRequest = {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, string>;
};

/** One typed tool: what it registers, which fields are path segments, and how
 *  its validated input becomes a `hapi_call` request. */
export type OrchestrationToolSpec<A> = {
  title: string;
  description: string;
  inputSchema: z.ZodType<A>;
  /** Input fields interpolated into the path; each must pass
   *  `isUnsafePathSegment` or the call is refused locally. */
  segments: readonly (keyof A & string)[];
  /** Input field that may not name this session (`self_permission_refused`). */
  refuseSelfField?: keyof A & string;
  /** Extra semantic checks; returns a field-named refusal or `null`. */
  check?: (args: A) => { field: string; error: string } | null;
  build: (args: A, selfSessionId: string) => TypedCallRequest;
};

/** Drop `undefined` values so a body or query carries only the keys given. */
function defined<T extends Record<string, unknown>>(rec: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(rec).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

const sessionIdField = z
  .string()
  .describe("Target session id (the `id` from list_sessions).");

// ── spawn_session ────────────────────────────────────────────────────────────

export type SpawnSessionArgs = {
  machineId: string;
  directory: string;
  agent?: "claude" | "codex" | "gemini" | "opencode";
  sessionType?: "simple" | "worktree";
  worktreeName?: string;
  sourceBranch?: string;
  existingBranch?: ExistingBranch;
  name?: string;
  yolo?: boolean;
  permissionMode?: PermissionMode;
  accountUuid?: string;
  forceAccount?: boolean;
  model?: string;
  modelMode?: string;
  effort?: EffortLevel;
  mcpSet?: McpSet;
};

export const spawnSessionTool: OrchestrationToolSpec<SpawnSessionArgs> = {
  title: "Spawn Peer Session",
  description:
    "Spawn a peer agent session on a machine and link it to THIS session as " +
    "its parent. sessionType: 'worktree' creates a git worktree for it. Wraps " +
    "machine-daemon.machine-spawn (POST /api/machines/:id/spawn, mutating). " +
    "Find machine ids with hapi_call {GET, /api/machines}. With neither yolo " +
    "nor permissionMode the peer starts in the node's default spawn " +
    "permission mode, one step below YOLO unless the operator chose otherwise " +
    "(Claude acceptEdits, Codex safe-yolo). Pass permissionMode for a specific " +
    "mode, or yolo: true for a peer that bypasses permission prompts. Unless " +
    "THIS session runs in a bypass permission mode, the peer is capped at THIS " +
    "session's tier (default, plan and read-only are tier 0; acceptEdits and " +
    "safe-yolo tier 1; YOLO tier 2): an explicit posture in a higher tier is " +
    "refused (agent_escalation_refused), and an omitted one is lowered to THIS " +
    "session's tier (to default at tier 0). A 409 account_exhausted means the " +
    "pinned accountUuid is at a usage cap: pin the named alternative, or pass " +
    "forceAccount: true to bind it anyway.",
  inputSchema: z.object({
    machineId: z.string().describe("Target machine id."),
    directory: z.string().describe("Absolute project directory."),
    agent: z.enum(["claude", "codex", "gemini", "opencode"]).optional(),
    sessionType: z
      .enum(["simple", "worktree"])
      .optional()
      .describe("worktree = run in a new git worktree."),
    worktreeName: z.string().optional(),
    sourceBranch: z
      .string()
      .optional()
      .describe("Branch a new worktree is cut from."),
    // The route's own schema (machines.ts spawnBodySchema), so a value the
    // route would refuse is refused here as a field-named invalid_input.
    existingBranch: ExistingBranchSchema.optional().describe(
      "Open the worktree on this existing branch: { name, remote }, remote " +
        "true when it exists only as origin/<name>."
    ),
    name: z.string().optional().describe("Session display name."),
    yolo: z
      .boolean()
      .optional()
      .describe(
        "true = the peer bypasses permission prompts. Omitted = the node's default spawn permission mode (not YOLO unless the operator set it)."
      ),
    permissionMode: z
      .enum(PERMISSION_MODES)
      .optional()
      .describe(
        "The peer's starting permission mode: default, acceptEdits, plan or bypassPermissions for Claude; default, read-only, safe-yolo or yolo for Codex. Overrides the node default; must agree with yolo when both are sent."
      ),
    accountUuid: z.string().optional(),
    // Issue #6028: the route accepts it and the 409 tells the caller to send
    // it; without it here the zod object stripped the key and an agent could
    // only repeat the same refused call.
    forceAccount: z
      .boolean()
      .optional()
      .describe(
        "Bind accountUuid even when it is at a usage cap; the response then carries a forced_exhausted_account warning."
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Codex/opencode gateway model only; ignored for Claude (use modelMode)."
      ),
    modelMode: z.string().optional(),
    // Issue #6166: the effort catalog, so a typo is a field-named invalid_input
    // here instead of a value the route would refuse. The route accepts an
    // effort on a non-Claude spawn and ignores it, so the description says so.
    effort: EffortLevelSchema.optional().describe(
      "Claude sessions only. Reasoning effort: low, medium, high, xhigh or max. Omit it to use the target node's default (xhigh unless the node sets HAPI_DEFAULT_EFFORT or settings.json defaultEffort)."
    ),
    // Issue #6171: the shared schema, because this zod object strips unknown
    // keys and a hand-copied shape would drift.
    mcpSet: McpSetSchema.optional().describe(
      'Claude sessions only. The MCP servers the peer starts with: {"mode":"only","servers":["name", ...]} (names as `claude mcp list` prints them; an empty list keeps only hapi) or {"mode":"all"}. Omit it to use the project\'s default set, else every server. hapi is always on. A server that is off for the project is refused unless listed in enableForProject, which turns it on for the whole project.'
    ),
  }) as z.ZodType<SpawnSessionArgs>,
  segments: ["machineId"],
  build: ({ machineId, ...rest }, selfSessionId) => ({
    method: "POST",
    path: `/api/machines/${machineId}/spawn`,
    // The wrapper, not the agent, stamps the parent link (the `hapi api`
    // default): #4450 R4 lets a spawner remove its peer's idle worktree by it.
    body: {
      ...defined(rest),
      // Issue #6218: a named mode travels with the yolo it implies, so a server
      // older than #6218 (which drops permissionMode and reads a missing yolo
      // as YOLO) starts the peer in default, never YOLO.
      ...(rest.permissionMode !== undefined && rest.yolo === undefined
        ? { yolo: isYoloEquivalentMode(rest.permissionMode) }
        : {}),
      parentSessionId: selfSessionId,
      parentRelationship: "spawn",
    },
  }),
};

// ── send_message ─────────────────────────────────────────────────────────────

export type SendMessageArgs = {
  sessionId: string;
  text: string;
  localId?: string;
};

export const sendMessageTool: OrchestrationToolSpec<SendMessageArgs> = {
  title: "Send Message to Session",
  description:
    "Send a user message to a peer session. The server stamps it as sent by " +
    "THIS session (cli-api). Wraps messaging.send-message " +
    "(POST /api/sessions/:id/messages, mutating). Unless THIS session runs in " +
    "a bypass permission mode, a message to a session in a bypass mode (or one " +
    "whose mode the server cannot read) is refused (agent_escalation_refused).",
  inputSchema: z.object({
    sessionId: sessionIdField,
    text: z.string().describe("Message text."),
    localId: z.string().optional().describe("Optional idempotency id."),
  }) as z.ZodType<SendMessageArgs>,
  segments: ["sessionId"],
  build: ({ sessionId, text, localId }) => ({
    method: "POST",
    path: `/api/sessions/${sessionId}/messages`,
    body: defined({ text, localId }),
  }),
};

// ── list_sessions ────────────────────────────────────────────────────────────

export type ListSessionsArgs = Record<string, never>;

export const listSessionsTool: OrchestrationToolSpec<ListSessionsArgs> = {
  title: "List Sessions",
  description:
    "List the sessions in this namespace with their ids, state and metadata. " +
    "Wraps session-introspection.list (GET /api/sessions, readonly).",
  inputSchema: z.object({}) as z.ZodType<ListSessionsArgs>,
  segments: [],
  build: () => ({ method: "GET", path: "/api/sessions" }),
};

// ── read_session_messages ────────────────────────────────────────────────────

export type ReadSessionMessagesArgs = {
  sessionId: string;
  limit?: number;
  beforeSeq?: number;
  afterSeq?: number;
};

export const readSessionMessagesTool: OrchestrationToolSpec<ReadSessionMessagesArgs> =
  {
    title: "Read Session Messages",
    description:
      "Read a session's message history, newest page first; page with " +
      "beforeSeq / afterSeq. Wraps messaging.list-messages " +
      "(GET /api/sessions/:id/messages).",
    inputSchema: z.object({
      sessionId: sessionIdField,
      // Bounds mirror the route's querySchema (messages.ts), which serves the
      // default page instead of refusing an out-of-range value.
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Page size, 1-200."),
      beforeSeq: z.number().int().min(1).optional(),
      afterSeq: z.number().int().min(0).optional(),
    }) as z.ZodType<ReadSessionMessagesArgs>,
    segments: ["sessionId"],
    build: ({ sessionId, limit, beforeSeq, afterSeq }) => {
      // #4011 R3: string values, only the keys given; the server appends them
      // after it gates the bare path. Ranges are enforced in the schema above.
      const query: Record<string, string> = {};
      if (limit !== undefined) query.limit = String(limit);
      if (beforeSeq !== undefined) query.beforeSeq = String(beforeSeq);
      if (afterSeq !== undefined) query.afterSeq = String(afterSeq);
      return {
        method: "GET",
        path: `/api/sessions/${sessionId}/messages`,
        ...(Object.keys(query).length > 0 ? { query } : {}),
      };
    },
  };

// ── archive_session ──────────────────────────────────────────────────────────

export type ArchiveSessionArgs = { sessionId: string };

export const archiveSessionTool: OrchestrationToolSpec<ArchiveSessionArgs> = {
  title: "Archive Session",
  description:
    "Archive (disconnect) a live session you are finished with; its record " +
    "stays. Wraps session-lifecycle.archive " +
    "(POST /api/sessions/:id/archive, mutating). Unless THIS session runs in a " +
    "bypass permission mode, you can archive only this session or one it " +
    "spawned; anything else is refused (agent_escalation_refused).",
  inputSchema: z.object({
    sessionId: sessionIdField,
  }) as z.ZodType<ArchiveSessionArgs>,
  segments: ["sessionId"],
  build: ({ sessionId }) => ({
    method: "POST",
    path: `/api/sessions/${sessionId}/archive`,
  }),
};

// ── create_schedule / update_schedule ────────────────────────────────────────

/** The schedule fields the typed tools expose; the route validates them (and
 *  accepts more — use hapi_call for the temporal-model layers). */
const scheduleFields = {
  name: z.string().optional(),
  emoji: z.string().optional(),
  prompt: z.string().optional().describe("Prompt the scheduled session runs."),
  projectDirectory: z.string().optional(),
  scheduleType: z.enum(["at", "every", "cron"]).optional(),
  cronExpression: z.string().optional(),
  scheduledAt: z.number().int().optional().describe("Epoch ms (type 'at')."),
  intervalMs: z.number().int().optional().describe("Interval (type 'every')."),
  timezone: z.string().optional(),
  deleteAfterRun: z.boolean().optional(),
  notifyOn: z.enum(["completion", "error", "both", "none"]).optional(),
  overlapPolicy: z.enum(["skip", "queue", "allow"]).optional(),
  sessionType: z.enum(["simple", "worktree"]).optional(),
};

type ScheduleFields = {
  name?: string;
  emoji?: string;
  prompt?: string;
  projectDirectory?: string;
  scheduleType?: "at" | "every" | "cron";
  cronExpression?: string;
  scheduledAt?: number;
  intervalMs?: number;
  timezone?: string;
  deleteAfterRun?: boolean;
  notifyOn?: "completion" | "error" | "both" | "none";
  overlapPolicy?: "skip" | "queue" | "allow";
  sessionType?: "simple" | "worktree";
};

export type CreateScheduleArgs = ScheduleFields & {
  name: string;
  prompt: string;
  projectDirectory: string;
  scheduleType: "at" | "every" | "cron";
};

const SCHEDULE_FLOOR_NOTE =
  "Scheduled sessions run in the bypass permission mode, so this is refused " +
  "(agent_escalation_refused) unless THIS session runs in a bypass mode.";

export const createScheduleTool: OrchestrationToolSpec<CreateScheduleArgs> = {
  title: "Create Schedule",
  description:
    "Create a scheduled task that runs a prompt in a project directory on a " +
    "cron, interval or one-shot timer. Wraps scheduler.create " +
    "(POST /api/schedules, mutating). " +
    SCHEDULE_FLOOR_NOTE,
  inputSchema: z.object({
    ...scheduleFields,
    name: z.string(),
    prompt: z.string().describe("Prompt the scheduled session runs."),
    projectDirectory: z.string(),
    scheduleType: z.enum(["at", "every", "cron"]),
  }) as z.ZodType<CreateScheduleArgs>,
  segments: [],
  build: args => ({
    method: "POST",
    path: "/api/schedules",
    body: defined(args),
  }),
};

export type UpdateScheduleArgs = ScheduleFields & {
  id: string;
  enabled?: boolean;
};

export const updateScheduleTool: OrchestrationToolSpec<UpdateScheduleArgs> = {
  title: "Update Schedule",
  description:
    "Update a scheduled task's timing, prompt or enablement; only the fields " +
    "given change. Wraps scheduler.update (PUT /api/schedules/:id, mutating). " +
    SCHEDULE_FLOOR_NOTE,
  inputSchema: z.object({
    id: z.string().describe("Schedule id."),
    ...scheduleFields,
    enabled: z.boolean().optional(),
  }) as z.ZodType<UpdateScheduleArgs>,
  segments: ["id"],
  build: ({ id, ...rest }) => ({
    method: "PUT",
    path: `/api/schedules/${id}`,
    body: defined(rest),
  }),
};

// ── respond_to_permission ────────────────────────────────────────────────────

export type RespondToPermissionArgs = {
  sessionId: string;
  requestId: string;
  decision: "approved" | "approved_for_session" | "denied" | "abort";
  mode?: string;
  allowTools?: string[];
  answers?: Record<string, string[]>;
};

/** Fields only the approve route accepts; refused with a deny decision rather
 *  than silently dropped. */
const APPROVE_ONLY_FIELDS = ["mode", "allowTools", "answers"] as const;

export const respondToPermissionTool: OrchestrationToolSpec<RespondToPermissionArgs> =
  {
    title: "Respond to Permission Request",
    description:
      "Approve or deny ANOTHER session's pending tool-permission request. " +
      "approved / approved_for_session approve; denied / abort deny. Wraps " +
      "model-permission.approve-permission / deny-permission (mutating). " +
      "Your own requests are refused (self_permission_refused), and any " +
      "response is refused (agent_escalation_refused) unless THIS session runs " +
      "in a bypass permission mode.",
    inputSchema: z.object({
      sessionId: sessionIdField,
      requestId: z.string().describe("Pending permission request id."),
      decision: z.enum(["approved", "approved_for_session", "denied", "abort"]),
      mode: z
        .string()
        .optional()
        .describe("Approve only: permission mode to switch the session to."),
      allowTools: z.array(z.string()).optional().describe("Approve only."),
      answers: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe("Approve only: answers to a question prompt."),
    }) as z.ZodType<RespondToPermissionArgs>,
    segments: ["sessionId", "requestId"],
    refuseSelfField: "sessionId",
    check: args => {
      if (args.decision !== "denied" && args.decision !== "abort") return null;
      const field = APPROVE_ONLY_FIELDS.find(f => args[f] !== undefined);
      return field
        ? { field, error: `${field} applies only to an approve decision` }
        : null;
    },
    build: ({ sessionId, requestId, decision, mode, allowTools, answers }) => {
      const base = `/api/sessions/${sessionId}/permissions/${requestId}`;
      return decision === "denied" || decision === "abort"
        ? { method: "POST", path: `${base}/deny`, body: { decision } }
        : {
            method: "POST",
            path: `${base}/approve`,
            body: defined({ decision, mode, allowTools, answers }),
          };
    },
  };

// ── remove_worktree (#4450) ──────────────────────────────────────────────────

export type RemoveWorktreeArgs = { machineId: string; worktreePath: string };

export const removeWorktreeTool: OrchestrationToolSpec<RemoveWorktreeArgs> = {
  title: "Remove Peer Worktree",
  description:
    "Move the idle git worktree of a peer session THIS session spawned to " +
    ".worktrees/.trash, where `scripts/hapi-worktree.sh recover` restores it. " +
    "Operator hosts only. Refused: your own worktree, one any process works " +
    "in or any other recorded session (even an archived one) points into, " +
    "one whose instance still claims a port, one on a " +
    "source or default branch, and one owned by a session you did not spawn. " +
    "Wraps machine-daemon.remove-idle-worktree " +
    "(POST /api/machines/:id/worktrees/remove, destructive) directly.",
  inputSchema: z.object({
    machineId: z
      .string()
      .describe("Machine id (from hapi_call {GET, /api/machines})."),
    worktreePath: z
      .string()
      .describe("Absolute path of the peer's worktree directory."),
  }) as z.ZodType<RemoveWorktreeArgs>,
  segments: ["machineId"],
  check: ({ worktreePath }) =>
    worktreePath.startsWith("/") &&
    !worktreePath.split("/").includes("..") &&
    !worktreePath.includes("%")
      ? null
      : {
          field: "worktreePath",
          error: "worktreePath must be absolute, with no '..' segment or '%'",
        },
  build: ({ machineId, worktreePath }) => ({
    method: "POST",
    path: `/api/machines/${machineId}/worktrees/remove`,
    body: { worktreePath },
  }),
};
