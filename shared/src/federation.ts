// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { ExistingBranchSchema } from "./gitBranches";
import { optionalSessionNameSchema } from "./sessionName";
import { ClaudeRemoteLauncherKindSchema } from "./launcherResolver";
import {
  DaemonCapSourceSchema,
  EffortLevelSchema,
  ModelModeSchema,
  ModelRoutingSchema,
  NativeModelSelectionSchema,
  SessionRoleSchema,
} from "./schemas";

// ─── Synthesized local-node identity (#2395) ─────────────────
//
// A standalone (federation-disabled) instance still has to report SOMETHING for
// itself. Before #2395 these two literals were duplicated across 7 production
// sites in `server/` and `web/`, with the server and client halves drifting
// independently — and `web/src/routes/settings/federation.tsx` compares `nodeId`
// across that boundary to decide which card is the local node, so a drift
// silently mis-identifies it in the UI.
//
// ⚠️ Note for future readers: three SERVER sites fall back a node *label* to
// `LOCAL_NODE_ID` ("local") rather than `LOCAL_NODE_LABEL` ("This node") —
// `spawnRoster.ts`, `telemetry.ts` and `systemJobs.ts`. That asymmetry predates
// #2395 and is preserved verbatim here because #2395 is a pure extraction;
// changing it would be a behaviour change. The extraction is what makes it
// visible: `?? LOCAL_NODE_ID` in a label position now reads as obviously odd.

/** Synthesized node id a standalone (federation-disabled) instance reports for itself. */
export const LOCAL_NODE_ID = "local";

/** Synthesized node label shown for the local node when no federation label is configured. */
export const LOCAL_NODE_LABEL = "This node";

/**
 * Issue #4462: advertised by every node whose binary carries the
 * `/api/federation/anthropic-login/{start,complete}` receivers, so a hub only
 * routes a node-targeted Anthropic login to a peer that can store it. A peer
 * without the tag is refused before any proxy call (`node_login_unsupported`).
 */
export const ANTHROPIC_LOGIN_CAPABILITY = "accounts:anthropic-login";

/**
 * The DNS suffix every cloud-provisioned Hapimatic VM lives under
 * (`scripts/provision.sh`: `FQDN="${SUBDOMAIN}.hapimatic.com"`, and the seeded
 * federation block's `selfUrl` is `https://<subdomain>.hapimatic.com`). Local
 * machines (RP1 / RP2 / SL7) announce Tailscale / LAN URLs and never carry it.
 */
export const CLOUD_NODE_HOST_SUFFIX = ".hapimatic.com";

/** True when a node URL points at a cloud-provisioned VM (see the suffix). */
export function isCloudNodeUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === CLOUD_NODE_HOST_SUFFIX.slice(1) ||
      host.endsWith(CLOUD_NODE_HOST_SUFFIX)
    );
  } catch {
    return false;
  }
}

/**
 * System-wide node-label casing rule (operator ruling, epic #3285 round 11,
 * 2026-09-07): **local machines render UPPER CASE, cloud machines lower case.**
 *
 * Before this, a node's label was whatever its `federation.nodeLabel` config
 * said ("RP1" on the prod hub, "rp1" where an instance fell back to its
 * hostname, "ms1" as `provision.sh` seeds it), so the same machine read
 * differently from surface to surface. The server applies this at the two
 * points a label ENTERS the system — its own config and every peer's
 * announced label — so every consumer (web, CLI, Telegram, alerts) sees one
 * casing; the web also applies it at its badge/label sites as a safety net for
 * a stale peer.
 *
 * Classification: cloud ⇔ the node's URL is under `CLOUD_NODE_HOST_SUFFIX`
 * (`cloud` may be passed explicitly when the caller already knows). The
 * synthesized fallback labels are left untouched.
 */
export function displayNodeLabel(
  label: string,
  opts: { url?: string | null; cloud?: boolean } = {}
): string {
  if (!label) return label;
  if (label === LOCAL_NODE_LABEL || label === "Unknown Node") return label;
  const cloud = opts.cloud ?? isCloudNodeUrl(opts.url);
  return cloud ? label.toLowerCase() : label.toUpperCase();
}

// ─── Configuration schemas ───────────────────────────────────

export const FederationNodeConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.string().url(),
});

export const FederationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  role: z.enum(["hub", "node", "peer"]).default("node"),
  nodeId: z.string().min(1),
  nodeLabel: z.string().min(1),
  nodes: z.array(FederationNodeConfigSchema).default([]),
  pollIntervalMs: z.number().int().positive().default(15000),
  /** This peer's own URL for announcement payloads. */
  selfUrl: z.string().url().optional(),
  /** Seed peer URLs to contact on startup for mesh discovery. */
  seedPeers: z.array(z.string().url()).default([]),
  /** Interval (ms) between periodic re-announcements to all known peers. */
  announceIntervalMs: z.number().int().positive().default(300_000),
  /** Absolute path to vanilla Claude Code CLI on this node.
   *  Used by the daemon when spawning sessions — overrides auto-detection.
   *  Set this when `claude` is not on PATH or not at ~/.local/bin/claude. */
  claudePath: z.string().optional(),
  /** Per-node opt-out for the turn-ledger mirror pull loop (issue #4614). When
   *  true, this node runs no pull loop and stores no mirror rows. The loop still
   *  registers (as "stopped") in the System Jobs portal so the opt-out is visible. */
  turnMirrorDisabled: z.boolean().optional(),
});

export type FederationNodeConfig = z.infer<typeof FederationNodeConfigSchema>;
export type FederationConfig = z.infer<typeof FederationConfigSchema>;

// ─── API response schemas ────────────────────────────────────

export const FederationNodeInfoSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string(),
  version: z.string(),
  role: z.enum(["hub", "node", "peer"]),
  capabilities: z.array(z.string()),
  sessionCount: z.number().int(),
  uptime: z.number(),
  platform: z.string().optional(),
  // Issue #2533: node's OS home dir, advertised so the Create page seeds a
  // remote node's real home. Optional — a stale peer (pre-#2533) omits it and
  // consumers degrade to the hub default + DirectoryBrowser recovery walk
  // (mirrors `platform` above; #536 stale-peer resilience).
  homeDir: z.string().optional(),
  // #1805: per-machine spawn capacity advertised over the federation info
  // channel. Optional for backward-compat — a stale peer (pre-#1805) won't
  // send these, so the consumer degrades to "unknown" instead of crashing
  // (mirrors `platform` above; #536 stale-code-peer resilience).
  effectiveCount: z.number().int().optional(),
  maxConcurrent: z.number().int().optional(),
  // #4417: the warn-at count + which resolver layer set the node's cap, so the
  // hub's Create-page meter can warn on a REMOTE target and Preferences can show
  // the resolved source for a remote node. BOTH optional — a pre-#4417 peer omits
  // them, so a consumer shows no warn threshold and reports the source as "remote"
  // (fail-open by design; the daemon gate is unchanged). [ER 2026-10-01: K3]
  recommendedConcurrent: z.number().int().optional(),
  capSource: DaemonCapSourceSchema.optional(),
});

export type FederationNodeInfo = z.infer<typeof FederationNodeInfoSchema>;

export const FederationInfoResponseSchema = z.object({
  node: FederationNodeInfoSchema,
});

export type FederationInfoResponse = z.infer<
  typeof FederationInfoResponseSchema
>;

export const FederationSessionsResponseSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string(),
  sessions: z.array(z.record(z.string(), z.unknown())),
  fetchedAt: z.number(),
});

export type FederationSessionsResponse = z.infer<
  typeof FederationSessionsResponseSchema
>;

// ─── Spawn request schema (node-to-node) ─────────────────────

export const FederationSpawnBodySchema = z.object({
  directory: z.string().min(1),
  agent: z.enum(["claude", "codex", "gemini", "opencode"]).optional(),
  yolo: z.boolean().optional(),
  /** Issue #1262: opt-in to spawn-time port claim. When omitted, the
   *  receiving federation route defaults to `true` for backward compat with
   *  older peers that don't send the field. */
  claimPort: z.boolean().optional(),
  sessionType: z.enum(["simple", "worktree"]).optional(),
  worktreeName: z.string().optional(),
  /** hapimatic-private#4481: open the worktree on this EXISTING branch. A peer
   *  that serves `/api/federation/git-branches` also honors this field (same
   *  release), and the web only offers existing branches from such a listing. */
  existingBranch: ExistingBranchSchema.optional(),
  name: optionalSessionNameSchema,
  emoji: z.string().optional(),
  /** NodeId of the peer that initiated this spawn (for dual-node visibility filtering) */
  originatingNodeId: z.string().optional(),
  /** Multi-account (epic #1446, R5 of Sub-Issue F #1452): bind the spawned
   *  session to this stored account on the receiving node. The receiver threads
   *  it into engine.spawnSession → HAPI_ACCOUNT_UUID; D's launcher injection
   *  (cli/src/claude/accountTokenInjection.ts) resolves the token node-locally.
   *  Only the UUID crosses the boundary — never a token. Absent → receiving
   *  node's default account. Validated as a UUID to match the sibling local
   *  spawnBodySchema (#1455). */
  accountUuid: z.string().uuid().optional(),
  /** Issue #2822 (epic #2478 D2a): managed-peer attribution — link the spawned
   *  session to its parent (the spawning PM). Mirrors the local spawnBodySchema
   *  (#2479), with one asymmetry: the hub forward (webClient.ts) resolves a
   *  tag-valued id to the parent's store uuid BEFORE forwarding, because the
   *  parent lives on the hub, not on the receiving node; the receiver stores it
   *  raw. Plain `.optional()` (not `.catch(undefined)`) like the local field — a
   *  malformed linkage 400s. Harmless (schema-dropped) on older peers. */
  parentSessionId: z.string().optional(),
  /** Issue #2822: "branch" | "spawn". The hub forward defaults it to "spawn" when
   *  a parent resolves, and omits both fields when it does not. */
  parentRelationship: z.enum(["branch", "spawn"]).optional(),
  /** Issue #1633: launch the claude child with --safe-mode (scaffolding
   *  disabled) on the receiving node. Mirrors the local spawnBodySchema. */
  safeMode: z.boolean().optional(),
  /** Issue #1660: per-session launcher override (sdk | tmux | pty) on the
   *  receiving node. Mirrors the local spawnBodySchema; validated by
   *  ClaudeRemoteLauncherKindSchema. Absent → receiving node's resolved
   *  default launcher (env > settings > sdk). */
  launcher: ClaudeRemoteLauncherKindSchema.optional(),
  /** Issue #1733: gateway model id ("provider/model") for an OpenRouter-routed
   *  Codex session on the receiving node. Mirrors the local spawnBodySchema. */
  model: z.string().optional(),
  /** Issue #3349 (D4(a)): native-vs-OpenRouter routing discriminator for the
   *  receiving node. Mirrors the local spawnBodySchema (#1262 — the federation
   *  hop is the "worst" silent-drop site; this mirror closes it). Absent → the
   *  receiving daemon degrades to model-presence-means-OpenRouter (R6 skew-safe).
   *  Harmless (schema-dropped) on older peers. */
  modelRouting: ModelRoutingSchema.optional(),
  /** Issue #2434: Claude model-mode pin ("sonnet"|"opus"|"fable"|"default") for
   *  the receiving node. Mirrors the local spawnBodySchema. DISTINCT from
   *  `model` above (the #1733 OpenRouter gateway axis) — the two coexist.
   *  Harmless (schema-dropped) on older peers. */
  modelMode: ModelModeSchema.optional(),
  /** Issue #2456: reasoning-effort level for the receiving node. Mirrors the
   *  local spawnBodySchema. Harmless (schema-dropped) on older peers. */
  effort: EffortLevelSchema.optional(),
  /** Issue #2456: specific pinned raw Claude model id (full-catalog "More
   *  models" selection) for the receiving node. Mirrors the local
   *  spawnBodySchema; threaded daemon-ward as --hapi-raw-model. Harmless
   *  (schema-dropped) on older peers. */
  rawModel: z.string().optional(),
  /** Issue #1953 (A6): clone-on-spawn repo ("owner/repo") for the receiving
   *  node. Mirrors the local spawnBodySchema; the peer clones it on spawn. */
  cloneRepo: z.string().optional(),
  /** Issue #2155: role-scoped `@`-include profile for the receiving node.
   *  Mirrors the local spawnBodySchema (incl. `.catch(undefined)` — an
   *  unrecognized role coerces to the FULL stack rather than 400ing, R3/V3). */
  sessionRole: SessionRoleSchema.optional().catch(undefined),
  /** Issue #2626 (D): per-session output style name ("default" | "Explanatory"
   *  | "Learning" or a custom style) for the receiving node. Mirrors the local
   *  spawnBodySchema; the peer threads it daemon-ward as --hapi-output-style.
   *  Lockstep-deploy caveat: a stale peer schema-STRIPS this field → the style
   *  is silently unset on the old peer (harmless), the same caveat the effort
   *  field documents. */
  outputStyle: z.string().optional(),
  /** Issue #3348: bundled non-claude native model selection (gemini id →
   *  GEMINI_MODEL env; codex id + effort → config.toml bake) for the receiving
   *  node. Mirrors the local spawnBodySchema; the peer conveys it per-agent at
   *  spawn. Harmless (schema-dropped) on older peers — the same lockstep caveat
   *  the effort/outputStyle fields document. */
  nativeModelSelection: NativeModelSelectionSchema.optional(),
  /** Correlation ID generated by the client to match the pending spawn stub
   *  with the real session once it appears in federation poll data. */
  spawnCorrelationId: z.string().uuid().optional(),
});

export type FederationSpawnBody = z.infer<typeof FederationSpawnBodySchema>;

// ─── Spawn status callback (node → hub) ─────────────────────

/** Sent by a remote node back to the originating hub when a background
 *  spawn completes (success or failure). Enables the hub to surface
 *  spawn errors to the client immediately instead of waiting for the
 *  120s pending-spawn timeout. */
export const FederationSpawnStatusSchema = z.object({
  /** Node that attempted the spawn */
  nodeId: z.string().min(1),
  /** Directory the spawn was requested for */
  directory: z.string().min(1),
  /** Client-generated correlation ID (if provided) */
  spawnCorrelationId: z.string().uuid().optional(),
  /** Whether the spawn succeeded */
  success: z.boolean(),
  /** Error message on failure */
  error: z.string().optional(),
  /** The sessionId of the spawned session (on success) */
  sessionId: z.string().optional(),
});

export type FederationSpawnStatus = z.infer<typeof FederationSpawnStatusSchema>;

// ─── Peer discovery schemas ─────────────────────────────────

/** Sent by a peer when it announces itself to another peer. */
export const PeerAnnouncementSchema = z.object({
  selfId: z.string().min(1),
  selfUrl: z.string().url(),
  selfLabel: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  version: z.string().optional(),
});

export type PeerAnnouncement = z.infer<typeof PeerAnnouncementSchema>;

/** A peer death-certificate (#2531). `evictedAt` is the epoch-ms eviction time.
 *  Propagated in the peer exchange so an explicit eviction (DELETE route /
 *  deprovision) removes a dead node mesh-wide; a newer DIRECT announce from the
 *  peer overrides a stale tombstone (proof of life). */
export const PeerTombstoneSchema = z.object({
  id: z.string().min(1),
  evictedAt: z.number().int(),
});

export type PeerTombstone = z.infer<typeof PeerTombstoneSchema>;

/** Returned by the announce endpoint — the receiving peer's known peer list. */
export const PeerExchangeResponseSchema = z.object({
  peers: z.array(
    z.object({
      id: z.string().min(1),
      url: z.string().url(),
      label: z.string().min(1),
      capabilities: z.array(z.string()).default([]),
      lastSeen: z.number().int(),
    })
  ),
  // Issue #2531: optional death-certificate list. `.default([])` keeps a pre-fix
  // peer's response (no `tombstones` field) valid during the lockstep-deploy
  // window (mixed-version safety, R5) — new nodes read tombstones when present,
  // old nodes simply omit them. Mirrors the `.default([])` on `capabilities`.
  tombstones: z.array(PeerTombstoneSchema).default([]),
});

export type PeerExchangeResponse = z.infer<typeof PeerExchangeResponseSchema>;

/** Returned by GET /api/federation/health. */
export const PeerHealthResponseSchema = z.object({
  selfId: z.string(),
  selfLabel: z.string(),
  version: z.string(),
  role: z.enum(["hub", "node", "peer"]),
  status: z.enum(["ok", "degraded"]),
  knownPeerCount: z.number().int(),
  uptime: z.number(),
});

export type PeerHealthResponse = z.infer<typeof PeerHealthResponseSchema>;

// ─── Node status for hub tracking ────────────────────────────

export type FederationNodeStatus = "online" | "degraded" | "offline";

export type FederationNodeState = {
  config: FederationNodeConfig;
  status: FederationNodeStatus;
  info: FederationNodeInfo | null;
  lastSuccessfulPoll: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

// ─── Force-poll result diff (#3456) ──────────────────────────
//
// Returned by `NodeRegistry.forcePoll()` (via `POST /api/nodes/poll`): a diff of
// what the forced federation sweep changed. `newlyOnline` = a node that was not
// `online` before the sweep and is `online` after; `stillOffline` = a node still
// `offline` after, with its `lastError` for the toast.

export const FederationPollResultSchema = z.object({
  newlyOnline: z.array(z.object({ id: z.string(), label: z.string() })),
  stillOffline: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      lastError: z.string().nullable(),
    })
  ),
  polledAt: z.number(),
});

export type FederationPollResult = z.infer<typeof FederationPollResultSchema>;
