// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { Context, Hono } from "hono";
import { defineCapability, sessionNameSchema } from "@hapi/protocol";
import type { CatalogEntry } from "@hapi/protocol";
import {
  CeilingGuardConfigPatchSchema,
  SessionViewSchema,
  UiCollapseStateSchema,
} from "@hapi/protocol/schemas";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { WebAppEnv } from "../middleware/auth";
import type { FederationDeps } from "./federation/shared";
import { checkFederationToken } from "./federation/shared";
import { cataloged } from "../../capabilities/cataloged";
import { logAndJson } from "./routeErrorHelper";

/**
 * Issue #2082 (epic #2077, Sub-Issue E): the single source of truth for
 * per-session FIELD mutations (emoji, timer, linked-issue, needs-review-override,
 * ui-collapse-state, notes, prompt-draft, name/rename).
 *
 * A field mutation historically touched THREE server layers, each with
 * near-identical per-field duplication (#966 §3 Priority 3 — the "4 edit sites
 * per field" antipattern):
 *   1. `web/routes/sessions.ts`             — client-API route (JWT context)
 *   2. `services/sessionService.ts`         — client-side local-or-proxy + cache
 *   3. `web/routes/federation/sessionMutations.ts` — peer-incoming receiver
 *
 * This module collapses layers 2 & 3 to a typed descriptor table plus two
 * generic helpers so the `registry.updateCachedSession*` cache-refresh call
 * (mandatory per docs/internal/architecture/federation.md "Federation Development Rules") is encoded
 * exactly ONCE, and adding a field is (mostly) a one-descriptor-entry change.
 *
 * Load-bearing invariants preserved:
 *  - #1063 SessionService audience boundary: layer-3 (federation receivers)
 *    NEVER proxies and calls `engine.*` directly. `localOrProxyMutation`
 *    (proxy-capable) is used only by the client side; `registerFederationFieldReceiver`
 *    is local-only.
 *  - #1097 two-layer auth: the receiver re-asserts caller namespace independently.
 *  - R4: `timer` has no cache method (`cacheUpdate` omitted).
 *  - R5: `linked-issue` keeps its #1584 duplicate-active-link 409 pre-check.
 *  - R8: typed function references only — NO string-keyed dispatch on engine/registry.
 *  - R9: `branch` is a lifecycle op and is intentionally NOT a field mutation.
 */

/** Result of a client-side field mutation. The route maps it to HTTP. */
export type SessionMutationResult =
  // Issue #3769 (Task 1d): `method` is set only by applySessionConfig (the
  // /model,/effort,/raw-model routes surface it as {ok:true, method}); every
  // other mutation leaves it undefined. Optional + additive.
  | { type: "success"; method?: "sdk" | "config" }
  | { type: "not-found" }
  | { type: "error"; message: string; status: number };

/** Result of a federation proxy request (the raw peer-node response). */
export type ProxyResult =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "not-found" }
  // Issue #2300 (Task 8, R4): `code` carries the peer node's error classifier
  // (e.g. "at_capacity") so a federated session's coded failure reaches the hub
  // client. Optional + additive — consumers that ignore it are unaffected;
  // absent on a genuine transport fault (proxyToNode's catch).
  | { type: "error"; message: string; status: number; code?: string };

/**
 * The client-side proxy primitive. `SessionService.proxyToNode` matches this
 * shape and is injected into {@link localOrProxyMutation} — keeping ONE proxy
 * implementation (with the #1097 `X-Hapi-Caller-Namespace` header) while the
 * generic stays unit-testable with a mock proxy.
 */
export type ProxyFn = (
  sessionId: string,
  pathSuffix: string,
  method: string,
  namespace: string,
  body?: unknown
) => Promise<ProxyResult>;

/**
 * A single per-session field mutation — the irreducible per-field specifics in
 * one place. `V` is the extracted field value threaded through the engine
 * update, the proxy body, and the cache update.
 */
export interface SessionFieldDescriptor<V> {
  /** Field name — for readability/debugging only. */
  readonly name: string;
  /** Path suffix after `/sessions/:id` — e.g. `/emoji`; `""` for rename. */
  readonly pathSuffix: string;
  /**
   * Capability-catalog entry for the peer-incoming PUT receiver (issue #3827,
   * epic #2416 Sub F.6). Written as a LITERAL `defineCapability({...})` so
   * #3743's AST generator collects it from this descriptor table (no adjacency
   * to `app.put(` required), and passed through `cataloged(...)` at the
   * `app.put` site in `registerFederationFieldReceiver` so #3742's ESLint rule
   * and the boot-time collector (#3743) both see it. Present on the 8 PUT field
   * descriptors; OMITTED for RENAME, which is cataloged at its hand-written
   * PATCH site in `federation/sessionMutations.ts` (a `catalogEntry` here too
   * would emit a duplicate index id).
   */
  readonly catalogEntry?: CatalogEntry;
  /** HTTP method — `PUT` for all fields except rename (`PATCH`). */
  readonly method: "PUT" | "PATCH";
  /** Shared Zod schema — validates the body on BOTH the client route and the receiver. */
  readonly schema: z.ZodType<unknown>;
  /** Pull the typed field value from the parsed body. */
  readonly extractValue: (parsed: unknown) => V;
  /** Apply the mutation to a LOCAL session via the engine. */
  readonly applyLocal: (
    engine: SyncEngine,
    sessionId: string,
    value: V
  ) => Promise<void>;
  /** Build the JSON body forwarded when proxying to the owning peer node. */
  readonly proxyBody: (value: V) => unknown;
  /**
   * Update the NodeRegistry cache after a successful PROXY (R3). Omitted for
   * `timer` (R4 — no `updateCachedSessionTimer` exists).
   */
  readonly applyCache?: (
    registry: NodeRegistry,
    sessionId: string,
    value: V
  ) => void;
  /**
   * Optional pre-dispatch hook — returns a short-circuit result (e.g. the
   * linked-issue #1584 duplicate-active-link 409), or `null` to proceed.
   */
  readonly preHook?: (
    engine: SyncEngine,
    sessionId: string,
    value: V,
    namespace: string
  ) => SessionMutationResult | null;
  /** Client-route (layer-1) 400 body when the shared schema rejects. */
  readonly clientInvalidBodyMessage: string | ((error: z.ZodError) => string);
  /** Federation receiver (layer-3) `logAndJson` category + fallback message. */
  readonly federationErrorCategory: string;
  readonly federationErrorFallback: string;
}

/**
 * Typed constructor for a descriptor — infers the schema output type so
 * `extractValue` is checked against it and `applyLocal`/`proxyBody`/`applyCache`
 * are checked against `V`. The cast only bridges the schema-output/`unknown`
 * gap in the stored table; every call site stays fully typed.
 */
function defineFieldMutation<S extends z.ZodTypeAny, V>(d: {
  name: string;
  pathSuffix: string;
  catalogEntry?: CatalogEntry;
  method: "PUT" | "PATCH";
  schema: S;
  extractValue: (parsed: z.infer<S>) => V;
  applyLocal: (
    engine: SyncEngine,
    sessionId: string,
    value: V
  ) => Promise<void>;
  proxyBody: (value: V) => unknown;
  applyCache?: (registry: NodeRegistry, sessionId: string, value: V) => void;
  preHook?: (
    engine: SyncEngine,
    sessionId: string,
    value: V,
    namespace: string
  ) => SessionMutationResult | null;
  clientInvalidBodyMessage: string | ((error: z.ZodError) => string);
  federationErrorCategory: string;
  federationErrorFallback: string;
}): SessionFieldDescriptor<V> {
  return d as unknown as SessionFieldDescriptor<V>;
}

// ── Shared Zod schemas (single source of truth for both route families) ──
const emojiSchema = z.object({ emoji: z.string().max(10).nullable() });
// Notes payload is opaque to the server: a legacy plain string OR a
// JSON-serialized NotesContent envelope (issue #1075). The 20KB cap (up from the
// legacy 5000) accommodates up to 10 attachments of modest metadata plus the
// 5000-char text body (which keeps its own cap inside NotesContentSchema). This
// single schema is the source of truth for BOTH the hub route and the federation
// receiver (#2082), so no second edit is needed. Matches promptDraftSchema below.
const notesSchema = z.object({ notes: z.string().max(20000).nullable() });
// Issue #3286 (View Picker): the persisted selected view. Enum-validated on BOTH
// the client route and the federation receiver via the shared SessionViewSchema
// (single source of truth), mirroring notesSchema.
const viewSchema = z.object({ view: SessionViewSchema.nullable() });
const promptDraftSchema = z.object({
  promptDraft: z.string().max(20000).nullable(),
});
const linkedIssueSchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().min(1).max(500),
    repo: z.string().min(1).max(200),
    state: z.enum(["open", "closed"]).optional(),
  })
  .nullable();
// Issue #2862 (Fix 1): the retroactive managed-peer parent stamp. Non-nullable
// (the route only SETS a link, never clears — a null parent is left to the
// existing dissolve path). Per expert-review 2862-5, `parentRelationship` is
// restricted to "spawn" (defaulted so the orphan-adoption caller may omit it):
// a "branch" stamp is written together with branchLabel/branchCreatedAt by
// updateSessionBranchInfo, so accepting "branch" here would create a label-less
// branch. Shared by the hub route AND the federation receiver (single source).
const parentSchema = z.object({
  parentSessionId: z.string().min(1).max(200),
  parentRelationship: z.literal("spawn").default("spawn"),
});
type ParentValue = z.infer<typeof parentSchema>;
const needsReviewOverrideSchema = z.enum(["read", "unread"]).nullable();
const autoRecoverFromApiErrorSchema = z.boolean().nullable();
// #3275: reuse the canonical shared schema (was a second inline Zod that
// listed only promptCollapsed/notesCollapsed — Zod .object() strips unknown
// keys, so tokenUsageCollapsed and the new detailsCollapsed were dropped at
// this route and never persisted). Reusing the shared schema keeps this route
// drift-proof as new collapse keys are added canonically.
const uiCollapseStateSchema = UiCollapseStateSchema.nullable();
const renameSchema = z.object({
  name: sessionNameSchema,
  skipTmuxSync: z.boolean().optional(),
});

type LinkedIssueValue = z.infer<typeof linkedIssueSchema>;

/**
 * Issue #1584: find an ACTIVE local session already linked to the given GitHub
 * issue, excluding the session being mutated. Local-node scope + namespace
 * scoped — moved verbatim from `SessionService` (its only consumer was the
 * linked-issue mutation). Two tenants may each link a session to the same
 * public issue, and the id in the 409 never leaks across namespaces.
 */
function findActiveSessionLinkedToIssue(
  engine: SyncEngine,
  number: number,
  repo: string,
  excludeSessionId: string,
  namespace: string
): string | null {
  for (const s of engine.getSessions()) {
    if (
      s.id !== excludeSessionId &&
      s.active &&
      s.namespace === namespace &&
      s.linkedIssue?.number === number &&
      s.linkedIssue?.repo === repo
    ) {
      return s.id;
    }
  }
  return null;
}

// ── The 8 field descriptors (single source of truth) ──

export const EMOJI_MUTATION = defineFieldMutation({
  name: "emoji",
  pathSuffix: "/emoji",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-emoji",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's emoji on the node that owns it. Peer-incoming PUT field receiver; the hub proxies here for a remote-owned session.",
    whenToUse:
      "When updating the emoji of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/emoji",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: emojiSchema,
  extractValue: p => p.emoji,
  applyLocal: (engine, id, value) => engine.updateSessionEmoji(id, value),
  proxyBody: value => ({ emoji: value }),
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionEmoji(id, value),
  clientInvalidBodyMessage:
    "Invalid body: emoji is required (string up to 10 chars or null)",
  federationErrorCategory: "federation-update-emoji",
  federationErrorFallback: "Failed to update session emoji",
});

export const LINKED_ISSUE_MUTATION = defineFieldMutation({
  name: "linked-issue",
  pathSuffix: "/linked-issue",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-linked-issue",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's linked GitHub issue on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the linked issue of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/linked-issue",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: linkedIssueSchema,
  extractValue: p => p,
  applyLocal: (engine, id, value) => engine.updateSessionLinkedIssue(id, value),
  proxyBody: value => value,
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionLinkedIssue(id, value),
  // R5: #1584 duplicate-active-link 409 pre-check (skipped on unlink).
  preHook: (engine, sessionId, value: LinkedIssueValue, namespace) => {
    if (!value) return null;
    const existingId = findActiveSessionLinkedToIssue(
      engine,
      value.number,
      value.repo,
      sessionId,
      namespace
    );
    if (existingId) {
      return {
        type: "error",
        status: 409,
        message: `Issue ${value.repo}#${value.number} is already linked to an active session (${existingId}). Unlink it first.`,
      };
    }
    return null;
  },
  clientInvalidBodyMessage:
    "Invalid body: expected { number, title, repo } or null",
  federationErrorCategory: "federation-update-linked-issue",
  federationErrorFallback: "Failed to update session linked issue",
});

// Issue #2862 (Fix 1): the retroactive, federation-aware managed-peer parent
// mutation. Mirrors LINKED_ISSUE_MUTATION so the hub route, the federation
// forward, and the auto-registered peer receiver share one schema + handler.
// The caller-supplied parentSessionId is resolved uuid-then-tag at LAYER 1 (the
// hub/cli route, which has the namespace + full registry view) and forwarded
// already-resolved — applyLocal runs on the OWNING peer, which may not know the
// parent, so per expert-review 2862-5 resolution must NOT happen here.
export const PARENT_MUTATION = defineFieldMutation({
  name: "parent",
  pathSuffix: "/parent",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-parent",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set a session's managed-peer parent link (parentSessionId + spawn relationship) on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When healing the parent stamp of an orphan whose spawn timed out after the daemon succeeded, on a session whose process lives on a remote node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/parent",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: parentSchema,
  extractValue: p => p,
  applyLocal: (engine, id, value) =>
    engine.updateSessionParentRelationship(
      id,
      value.parentSessionId,
      value.parentRelationship
    ),
  proxyBody: value => value,
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionParentRelationship(
      id,
      value.parentSessionId,
      value.parentRelationship
    ),
  // #2862 (2862-5): reject a self-parent (would self-group / cycle). No 409
  // duplicate pre-check like linked-issue — multiple children share one parent.
  preHook: (_engine, sessionId, value: ParentValue) => {
    if (value.parentSessionId === sessionId) {
      return {
        type: "error",
        status: 400,
        message: "A session cannot be its own parent",
      };
    }
    return null;
  },
  clientInvalidBodyMessage:
    'Invalid body: expected { parentSessionId: string, parentRelationship?: "spawn" }',
  federationErrorCategory: "federation-update-parent",
  federationErrorFallback: "Failed to update session parent",
});

export const NEEDS_REVIEW_OVERRIDE_MUTATION = defineFieldMutation({
  name: "needs-review-override",
  pathSuffix: "/needs-review-override",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-needs-review-override",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's needs-review override (read or unread) on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the needs-review override of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/needs-review-override",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: needsReviewOverrideSchema,
  extractValue: p => p,
  applyLocal: (engine, id, value) =>
    engine.updateSessionNeedsReviewOverride(id, value),
  proxyBody: value => value,
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionNeedsReviewOverride(id, value),
  clientInvalidBodyMessage: 'Invalid body: expected "read", "unread", or null',
  federationErrorCategory: "federation-update-needs-review",
  federationErrorFallback: "Failed to update session review override",
});

export const AUTO_RECOVER_MUTATION = defineFieldMutation({
  name: "auto-recover",
  pathSuffix: "/auto-recover",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-auto-recover",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's auto-recover-from-API-error override on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the auto-recover override of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/auto-recover",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: autoRecoverFromApiErrorSchema,
  extractValue: p => p,
  applyLocal: (engine, id, value) =>
    engine.updateSessionAutoRecoverFromApiError(id, value),
  proxyBody: value => value,
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionAutoRecoverFromApiError(id, value),
  clientInvalidBodyMessage: "Invalid body: expected true, false, or null",
  federationErrorCategory: "federation-update-auto-recover",
  federationErrorFallback: "Failed to update session auto-recover override",
});

export const UI_COLLAPSE_STATE_MUTATION = defineFieldMutation({
  name: "ui-collapse-state",
  pathSuffix: "/ui-collapse-state",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-ui-collapse-state",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Persist a session's UI collapse state on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the UI collapse state of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/ui-collapse-state",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: uiCollapseStateSchema,
  extractValue: p => p,
  applyLocal: (engine, id, value) =>
    engine.updateSessionUiCollapseState(id, value),
  proxyBody: value => value,
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionUiCollapseState(id, value),
  clientInvalidBodyMessage:
    "Invalid body: expected { promptCollapsed?: boolean, notesCollapsed?: boolean, tokenUsageCollapsed?: boolean, detailsCollapsed?: boolean } or null",
  federationErrorCategory: "federation-update-ui-collapse",
  federationErrorFallback: "Failed to update session UI collapse state",
});

export const NOTES_MUTATION = defineFieldMutation({
  name: "notes",
  pathSuffix: "/notes",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-notes",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's notes on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the notes of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/notes",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: notesSchema,
  extractValue: p => p.notes,
  applyLocal: (engine, id, value) => engine.updateSessionNotes(id, value),
  proxyBody: value => ({ notes: value }),
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionNotes(id, value),
  clientInvalidBodyMessage:
    "Invalid body: notes is required (string up to 20000 chars or null)",
  federationErrorCategory: "federation-update-notes",
  federationErrorFallback: "Failed to update session notes",
});

// Issue #3286 (View Picker): server-persisted selected view, symmetric to NOTES.
export const VIEW_MUTATION = defineFieldMutation({
  name: "view",
  pathSuffix: "/view",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-view",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Persist a session's selected view (chat, terminal, desktop, files) on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the selected view of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/view",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: viewSchema,
  extractValue: p => p.view,
  applyLocal: (engine, id, value) => engine.updateSessionView(id, value),
  proxyBody: value => ({ view: value }),
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionView(id, value),
  clientInvalidBodyMessage:
    'Invalid body: view must be "chat", "terminal", "desktop", "files", or null',
  federationErrorCategory: "federation-update-view",
  federationErrorFallback: "Failed to update session view",
});

export const PROMPT_DRAFT_MUTATION = defineFieldMutation({
  name: "prompt-draft",
  pathSuffix: "/prompt-draft",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-prompt-draft",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's prompt draft on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the prompt draft of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/prompt-draft",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: promptDraftSchema,
  extractValue: p => p.promptDraft,
  applyLocal: (engine, id, value) => engine.updateSessionPromptDraft(id, value),
  proxyBody: value => ({ promptDraft: value }),
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionPromptDraft(id, value),
  clientInvalidBodyMessage:
    "Invalid body: promptDraft is required (string up to 20000 chars or null)",
  federationErrorCategory: "federation-update-prompt-draft",
  federationErrorFallback: "Failed to update session prompt draft",
});

/** Value for rename — carries both the new name and the (optional) options. */
export type RenameValue = {
  name: string;
  options: { skipTmuxSync?: boolean } | undefined;
};

export const RENAME_MUTATION = defineFieldMutation({
  name: "name",
  pathSuffix: "",
  method: "PATCH",
  schema: renameSchema,
  // Unused by the receiver loop (rename's receiver is hand-written — PATCH +
  // dynamic 400 + 409 concurrency); defined for table consistency.
  extractValue: p => ({
    name: p.name,
    options: { skipTmuxSync: p.skipTmuxSync },
  }),
  applyLocal: (engine, id, value: RenameValue) =>
    engine.renameSession(id, value.name, value.options),
  proxyBody: (value: RenameValue) => ({
    name: value.name,
    ...(value.options?.skipTmuxSync ? { skipTmuxSync: true } : {}),
  }),
  applyCache: (registry, id, value: RenameValue) =>
    registry.updateCachedSessionName(id, value.name),
  clientInvalidBodyMessage: error =>
    error.issues[0]?.message ?? "Invalid body: name is required",
  federationErrorCategory: "federation-rename-session",
  federationErrorFallback: "Failed to rename session",
});

// Issue #1905: the per-session runaway-guard ceiling override. A partial
// {@link CeilingGuardConfigPatchSchema} (any subset of the ceiling fields) or
// `null` to clear. Shared by the hub route AND the federation receiver (single
// source). Appending it to SESSION_FIELD_MUTATIONS auto-registers the peer
// receiver (federation/sessionMutations.ts loops the table — no edit there).
export const CEILING_OVERRIDE_MUTATION = defineFieldMutation({
  name: "ceiling-override",
  pathSuffix: "/ceiling-override",
  catalogEntry: defineCapability({
    id: "session-lifecycle.api-federation-sessions-ceiling-override",
    domain: "session-lifecycle",
    surface: "rest",
    description:
      "Set or clear a session's per-session runaway-guard ceiling override on the node that owns it. Peer-incoming PUT field receiver for a remote-owned session.",
    whenToUse:
      "When updating the ceiling override of a session whose process lives on a remote federation node.",
    invocation: {
      kind: "rest",
      method: "PUT",
      path: "/api/federation/sessions/:id/ceiling-override",
    },
    auth: "federation-token",
    riskTier: "mutating",
    availability: { scope: "operator" },
  }),
  method: "PUT",
  schema: CeilingGuardConfigPatchSchema.nullable(),
  extractValue: p => p,
  // The writer's boolean (#5254) is for the ceiling guard's seed step; the
  // route keeps its void contract.
  applyLocal: async (engine, id, value) => {
    await engine.updateSessionCeilingOverride(id, value);
  },
  proxyBody: value => value,
  applyCache: (registry, id, value) =>
    registry.updateCachedSessionCeilingOverride(id, value),
  clientInvalidBodyMessage:
    "Invalid body: expected a partial ceiling-guard config object or null",
  federationErrorCategory: "federation-update-ceiling-override",
  federationErrorFallback: "Failed to update session ceiling override",
});

/**
 * The full field-mutation table. Layer-1 references the named descriptors for
 * schema + 400 message; layer-2 (`SessionService`) delegates to
 * {@link localOrProxyMutation}; layer-3 loops the PUT descriptors through
 * {@link registerFederationFieldReceiver}.
 */
export const SESSION_FIELD_MUTATIONS: readonly SessionFieldDescriptor<unknown>[] =
  [
    EMOJI_MUTATION,
    LINKED_ISSUE_MUTATION,
    PARENT_MUTATION,
    NEEDS_REVIEW_OVERRIDE_MUTATION,
    AUTO_RECOVER_MUTATION,
    UI_COLLAPSE_STATE_MUTATION,
    NOTES_MUTATION,
    VIEW_MUTATION,
    PROMPT_DRAFT_MUTATION,
    RENAME_MUTATION,
    CEILING_OVERRIDE_MUTATION,
  ] as SessionFieldDescriptor<unknown>[];

/** Injected dependencies for the client-side generic. */
export interface MutationContext {
  engine: SyncEngine;
  registry: NodeRegistry | null;
  proxy: ProxyFn;
}

/**
 * Client-side (layers 1/2) generic: run the optional pre-hook, then apply the
 * mutation to a LOCAL session via the engine, or PROXY it to the owning peer
 * and — on proxy success — update the NodeRegistry cache exactly once (R3).
 * Returns the same `SessionMutationResult` the per-field methods returned, so
 * route→HTTP mapping is unchanged.
 */
export async function localOrProxyMutation<V>(
  ctx: MutationContext,
  descriptor: SessionFieldDescriptor<V>,
  sessionId: string,
  value: V,
  namespace: string
): Promise<SessionMutationResult> {
  if (descriptor.preHook) {
    const pre = descriptor.preHook(ctx.engine, sessionId, value, namespace);
    if (pre) return pre;
  }

  if (ctx.engine.getSession(sessionId) !== undefined) {
    await descriptor.applyLocal(ctx.engine, sessionId, value);
    return { type: "success" };
  }

  const result = await ctx.proxy(
    sessionId,
    descriptor.pathSuffix,
    descriptor.method,
    namespace,
    descriptor.proxyBody(value)
  );
  if (result.type === "success") {
    // A resolved node implies a non-null registry; the guard is defensive and
    // never skips a reachable cache-update. Omitted entirely for timer (R4).
    if (ctx.registry) {
      descriptor.applyCache?.(ctx.registry, sessionId, value);
    }
    return { type: "success" };
  }
  return result;
}

/** Resolve a descriptor's client-route (layer-1) 400 body. */
export function resolveClientInvalidBody<V>(
  descriptor: SessionFieldDescriptor<V>,
  error: z.ZodError
): string {
  return typeof descriptor.clientInvalidBodyMessage === "function"
    ? descriptor.clientInvalidBodyMessage(error)
    : descriptor.clientInvalidBodyMessage;
}

/**
 * Register a peer-incoming (layer-3) receiver for a uniform PUT field mutation.
 * ALWAYS local — federation receivers never proxy (#1063 audience boundary).
 * `checkCallerNamespace` is injected (its home stays `federation/sessionMutations.ts`)
 * to avoid a value import cycle. Rename (PATCH) is NOT registered here — it keeps
 * its hand-written receiver (dynamic 400 message + concurrency→409 mapping).
 */
export function registerFederationFieldReceiver<V>(
  app: Hono<WebAppEnv>,
  deps: FederationDeps,
  descriptor: SessionFieldDescriptor<V>,
  checkCallerNamespace: (
    c: Context<WebAppEnv>,
    session: { namespace: string }
  ) => Response | null
): void {
  // #3827 (R11): the loop registers a PUT with a TEMPLATE-literal path, which
  // #3743's generator cannot read. The literal `defineCapability({...})` lives on
  // the descriptor (`descriptor.catalogEntry`) so the AST generator collects it
  // from the table; here we pass it through `cataloged(...)` so #3742's ESLint
  // rule and the boot-time collector both tag this route. Fail loud if a PUT
  // descriptor is missing its entry (the const assignment also narrows the
  // optional type so `cataloged(...)` type-checks without a non-null assertion).
  const catalogEntry = descriptor.catalogEntry;
  if (!catalogEntry) {
    throw new Error(
      `registerFederationFieldReceiver: descriptor "${descriptor.name}" has no ` +
        `catalogEntry — every looped PUT field receiver must carry a literal ` +
        `defineCapability({...}) entry (issue #3827).`
    );
  }
  app.put(
    `/federation/sessions/:id${descriptor.pathSuffix}`,
    cataloged(catalogEntry),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = descriptor.schema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      try {
        await descriptor.applyLocal(
          engine,
          sessionId,
          descriptor.extractValue(parsed.data)
        );
        return c.json({ ok: true });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: descriptor.federationErrorCategory,
          fallbackMessage: descriptor.federationErrorFallback,
        });
      }
    }
  );
}
