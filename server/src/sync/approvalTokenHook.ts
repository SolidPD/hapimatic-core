// SPDX-License-Identifier: AGPL-3.0-only
/**
 * USER-APPROVAL token-verify message hook (issue #3331, epic #3329 Sub-Issue B).
 *
 * The authoritative verification gate (R1). Registered on the #3124 message-hook
 * stage (Task 9) so it runs INSIDE the delivery path, BEFORE a message is
 * persisted — a `USER-APPROVAL-` token in an inbound user message is verified
 * against its pending challenge and either mints a single-use grant (delivery
 * proceeds) or DENIES delivery with a machine-readable reason.
 *
 * A FACTORY, not a bare handler: the handler receives only
 * `{text, sessionId, sentFrom, event, origin}` (`messageHooks.ts`) and cannot
 * reach the filesystem repo path on its own, so the factory closes over the SAME
 * `getSessionMetadata` lookup the engine already injects at
 * `syncEngine.ts:424-430`. `sessionId → metadata.path` (a validated absolute
 * working dir) → `<path>/claudedocs/…`. No `messageHooks.ts` change is needed
 * for the path resolution; the `origin` field IS threaded through the hook input
 * (a minimal, additive extension) because R1's provenance check and R3's
 * self-send check both need it and `meta.origin` is stamped only AFTER the hook
 * runs.
 *
 * Config (registry §5 + directive Key Decisions): `gateClass: true` (a security
 * gate MUST deny on timeout — fail-closed) and `harnessScope: "all"`
 * (`no-native-equivalent` would silently skip the gate on any harness whose
 * hooks axis is native, i.e. a stock claude session). The hook is admitted for
 * genuine user origins by default (a `cli-api` send stays `sentFrom: "webapp"`
 * under the companion-`meta.origin` design, so no `origins` opt-in is needed).
 */
import type { Metadata } from "@hapi/protocol";
import type { MessageHookConfig } from "@hapi/protocol";
import type { MessageHookHandler, MessageHookResult } from "./messageHooks";
import { registerMessageHook } from "./messageHooks";
import {
  buildProvenanceComment,
  coerceProvenanceScope,
  describeKey,
  extractToken,
  globalGrantFile,
  grantFile,
  verifyToken,
  type OriginTipResolver,
  type VerifyResult,
} from "../services/approvalTokens";
import type { MintRecord } from "./orphanGrantStep";
import {
  parseRepoSlug,
  runGit,
  type IsValidOptions,
} from "../services/stateBinding";
import { runGhWithBunSpawn, type GhRunner } from "../utils/githubCli";
import {
  classifyRestStatus,
  resolveGitHubToken,
  type FetchImpl,
} from "../utils/githubRest";
import type { ApprovalTokensConfig } from "../config/approvalTokensConfig";

/** The stable hook id (surfaced in a denial `{delivered:false, hookId}`). */
export const APPROVAL_TOKEN_HOOK_ID = "user-approval-token-gate";

/** The message-hook config for the token gate (registry + Key Decisions). */
export const approvalTokenHookConfig: MessageHookConfig = {
  id: APPROVAL_TOKEN_HOOK_ID,
  event: "UserPromptSubmit",
  // "all" — a gate must run on EVERY harness (a native-hooks harness must not
  // dedup this away; the gate has no native equivalent that would double-cover).
  harnessScope: "all",
  timeoutMs: 5000,
  // Belt-and-suspenders; gateClass already forces deny-on-timeout regardless.
  failPolicy: "closed",
  gateClass: true,
  dedupKey: "user-approval-token-gate",
  handler: { kind: "builtin", id: APPROVAL_TOKEN_HOOK_ID },
};

export interface ApprovalTokenHookDeps {
  /** The engine's session-metadata lookup (already built at syncEngine.ts:424). */
  getSessionMetadata: (sessionId: string) => Metadata | undefined;
  /** Injected token-gate config (R7 allowlist flag). */
  config: ApprovalTokensConfig;
  /** Injected hygiene-TTL days for #3332's fingerprint-less path. */
  hygieneTtlDays?: number;
  /** Optional structured logger. */
  log?: (message: string, context?: Record<string, unknown>) => void;
  /**
   * #3653: inject the APPROVAL_PROVENANCE comment poster. Tests substitute a
   * fake; production uses {@link createDefaultPostComment} (gh-then-REST) when
   * absent — so the `registerApprovalTokenGate` call site in `syncEngine.ts`
   * needs no change and the existing tests stay backward-compatible.
   */
  postComment?: (slug: string, issue: number, body: string) => Promise<boolean>;
  /**
   * #3653 (test-only): state-binding passthrough merged into the `verifyToken`
   * `stateBinding` option so a hook-level test can reach `granted` with the
   * deterministic no-drift resolver the service tests use. Production passes
   * nothing here — byte-identical to pre-#3653.
   */
  stateBinding?: Pick<
    IsValidOptions,
    "resolveTargetChanges" | "runGh" | "fetchImpl" | "env"
  >;
  /**
   * #3563 (R1): record a fresh grant's mint keyed on the gated session id, so a
   * later terminal signal (rate-limit / api-error / turn abort / account switch)
   * can detect an orphaned grant and post a proactive resume notice. Optional —
   * tests and any construction that predates #3563 omit it and the mint is simply
   * not recorded (no notice), byte-identical to pre-#3563. No change to
   * verify/mint/deny semantics (R5).
   */
  recordMint?: (sessionId: string, record: MintRecord) => void;
  /**
   * #3619 (D1-A, test-only): inject the prod-merge origin-tip resolver so a
   * hook-level test can reach `granted` on a scope:"repo-independent"
   * prod-merge challenge WITHOUT a real git fetch. Production omits it ->
   * verifyToken's default real-fetch resolver runs (byte-identical to
   * pre-#3619). Mirrors the stateBinding / postComment test-only passthroughs.
   */
  prodMergeTip?: OriginTipResolver;
}

/**
 * Build the token-verify handler. It NEVER throws — a missing/unresolvable
 * `metadata.path` yields a typed deny (`provenance-rejected`), never a silent
 * allow (a gate that cannot locate the challenge must not pass the message).
 */
export function createApprovalTokenHook(
  deps: ApprovalTokenHookDeps
): MessageHookHandler {
  return async (input): Promise<MessageHookResult> => {
    const token = extractToken(input.text);
    if (!token) {
      // No token in this message — the gate is a no-op (delivery proceeds).
      return {};
    }

    const metadata = deps.getSessionMetadata(input.sessionId);
    const repoPath =
      typeof metadata?.path === "string" && metadata.path.length > 0
        ? metadata.path
        : undefined;
    if (!repoPath) {
      // Fail-closed: a token is present but we cannot locate its challenge dir.
      deps.log?.(
        `approval-token gate: unresolvable repo path for session ${input.sessionId} — denying (fail-closed)`,
        { hookId: APPROVAL_TOKEN_HOOK_ID, sessionId: input.sessionId }
      );
      return { deny: { reason: "provenance-rejected" } };
    }

    const result = await verifyToken(repoPath, token, {
      gatedSessionId: input.sessionId,
      origin: input.origin,
      config: deps.config,
      // #3538: the injected machine-global bypass-scope store base. A repo-local
      // nonce miss falls back here; undefined ⇒ repo-local-only (byte-identical).
      globalStateDir: deps.config.globalStateDir,
      // Production: no resolver override → #3332's default gh-then-REST
      // target-drift resolver runs against the real remote. The #3653 test-only
      // passthrough (absent in production) lets a hook-level test inject a
      // deterministic no-drift resolver to reach `granted`.
      stateBinding: {
        hygieneTtlDays: deps.hygieneTtlDays,
        ...deps.stateBinding,
      },
      // #3619 (D1-A): production omits deps.prodMergeTip -> verifyToken's
      // default real-fetch origin-ref resolver runs. A hook-level test
      // injects a deterministic tip here for a network-free prod-merge grant.
      prodMergeTip: deps.prodMergeTip,
    });

    switch (result.ok) {
      case "granted":
        deps.log?.(
          `approval-token gate: granted ${describeKey(result.key)} (${result.grant.origin})`,
          { hookId: APPROVAL_TOKEN_HOOK_ID, sessionId: input.sessionId }
        );
        // #3653: post a durable APPROVAL_PROVENANCE comment on the granted issue
        // so rp1-home's close gate (validate-label-transition.py) finds the
        // provenance artifact a token-driven close otherwise lacks
        // (close_without_provenance). DETACHED — never awaited inside the 5s
        // fail-closed race: executeHook (messageHooks.ts) denies on timeout
        // REGARDLESS of policy, and mintGrant has ALREADY consumed the challenge
        // by this point, so a timeout-deny here would strand the grant and wedge
        // the user's re-send into `replayed` (the exact failure R2 forbids).
        // Fail-soft: a post failure degrades to the pre-#3653 audit state, never
        // a denied approval.
        void emitGrantProvenance(result, {
          repoPath,
          postComment:
            deps.postComment ?? createDefaultPostComment({ log: deps.log }),
          log: deps.log,
        }).catch(err =>
          deps.log?.(
            `approval-token gate: provenance emit threw (ignored): ${String(err)}`,
            { hookId: APPROVAL_TOKEN_HOOK_ID, sessionId: input.sessionId }
          )
        );
        // #3563 (R1): record the mint keyed on the gated session id so a later
        // terminal signal can detect an orphaned grant. No turn id exists at mint
        // time (the turn opens only after this message is delivered), so the record
        // keys on sessionId + carries the nonce (the re-check matches by nonce, not
        // presence), the already-resolved repoPath, and the resolved grant PATH so a
        // #3538 scope-keyed GLOBAL grant is orphan-checkable identically to an
        // issue-scoped one. A scope key with no injected globalStateDir cannot have
        // a durable grant to re-check, so it is not recorded. FAIL-OPEN: a server
        // restart before the turn ends loses the record → no notice.
        if (deps.recordMint) {
          const grantPath =
            result.key.kind === "issue"
              ? grantFile(repoPath, result.key.issueNumber)
              : deps.config.globalStateDir
                ? globalGrantFile(
                    deps.config.globalStateDir,
                    result.key.scopeKey
                  )
                : null;
          if (grantPath) {
            deps.recordMint(input.sessionId, {
              key: result.key,
              nonce: result.grant.nonce,
              mintedAt: result.grant.minted_at,
              repoPath,
              grantPath,
            });
          }
        }
        // Grant minted; deliver the approval message so the agent proceeds.
        return {};
      case "overlap":
        // Ruling D1a — the decision-menu flow, NOT a denial. Deliver the message
        // with the overlap surfaced as context so a human/agent decides; no
        // grant is minted until the overlap is resolved.
        deps.log?.(
          `approval-token gate: overlap on ${describeKey(result.key)} — surfacing decision menu`,
          { hookId: APPROVAL_TOKEN_HOOK_ID, sessionId: input.sessionId }
        );
        return {
          additionalContext: formatOverlapDecisionMenu(
            describeKey(result.key),
            result.analysis
          ),
        };
      case "already-granted": {
        // Idempotent RESUME (#3559 R2): a valid grant for this key already exists
        // (minted, not gate-consumed). DELIVER the message — mint NOTHING, never
        // auto-consume, never re-run the close (D4) — and emit a NON-blocking
        // notice on #3579's notice channel. D3 (ruled): do NOT use
        // `additionalContext` — `runMessageHooks` PREPENDS it INTO the user's
        // persisted message (messageHooks.ts → messageService.ts), so it would
        // surface agent-facing text inside the user's OWN chat bubble on every
        // client and after reload (an R5 violation — the `overlap` arm leaks this
        // way; do NOT copy it). Emit NO agent-directed text: the closer's gate
        // finds the grant on disk and completes the close with no special phrase.
        deps.log?.(
          `approval-token gate: already-granted ${describeKey(
            result.key
          )} — idempotent resume (no mint)`,
          { hookId: APPROVAL_TOKEN_HOOK_ID, sessionId: input.sessionId }
        );
        const noticeParams: Record<string, string | number> = {};
        if (result.key.kind === "issue")
          noticeParams.issueNumber = result.key.issueNumber;
        if (result.grant.minted_at) noticeParams.at = result.grant.minted_at;
        return {
          notice: {
            hookId: APPROVAL_TOKEN_HOOK_ID,
            code: "already-granted",
            params: noticeParams,
          },
        };
      }
      case "denied": {
        // The hook resolves NO copy (D3 / 1B-8): #3579's stage resolves the
        // catalogue SERVER-SIDE from (hookId, reason) and substitutes `params`.
        // Attach the copy-template params so a ledger-confirmed `replayed` renders
        // `#N` + the consumption instant; other denials carry none.
        const denyParams: Record<string, string | number> = {};
        if (result.issueNumber != null)
          denyParams.issueNumber = result.issueNumber;
        if (result.at != null) denyParams.at = result.at;
        return {
          deny: {
            reason: result.reason,
            ...(Object.keys(denyParams).length > 0
              ? { params: denyParams }
              : {}),
          },
        };
      }
    }
  };
}

/**
 * Register the token-verify gate on the message-hook stage (Task 9). Called once
 * at server boot from the `SyncEngine` construction site (beside the
 * `MessageService` build), where the `getSessionMetadata` closure the hook
 * factory needs already exists. `registerMessageHook` keys the registry by hook
 * id (a module-global `Map`), so this is idempotent by id — a re-constructed
 * engine (tests) re-binds the closure to the new instance rather than
 * duplicating the hook.
 */
export function registerApprovalTokenGate(deps: ApprovalTokenHookDeps): void {
  registerMessageHook(approvalTokenHookConfig, createApprovalTokenHook(deps));
}

// ── #3653: APPROVAL_PROVENANCE comment emit (server half of epic #3329 D6a) ───
//
// The impure side of Task 1's pure formatter. Confined to the hook module
// (approvalTokens.ts stays pure). Emits ONLY on a fresh `granted` ISSUE key —
// never on denied/overlap, never on the #3559 `already-granted` arm, never on a
// #3538 `kind: "scope"` bypass key (R3). DETACHED + FAIL-SOFT by construction.

/** Max wall-clock for the detached post. Bounds a hung transport so the emit
 *  promise settles; it NEVER affects the hook's already-returned `{}`. */
const PROVENANCE_POST_TIMEOUT_MS = 15_000;

/** Resolve the close-target `owner/repo` slug from a repo working dir. Test seam
 *  (default: `git remote get-url origin` → {@link parseRepoSlug}). */
export type SlugResolver = (repoPath: string) => Promise<string | null>;

const defaultResolveSlug: SlugResolver = async repoPath => {
  const url = (
    await runGit(["remote", "get-url", "origin"], repoPath)
  ).stdout.trim();
  return parseRepoSlug(url);
};

export interface EmitGrantProvenanceDeps {
  /** Absolute repo working dir (the gated session's `metadata.path`). */
  repoPath: string;
  /** The comment poster — an injected fake in tests; production passes
   *  {@link createDefaultPostComment}. Resolves `true` iff the comment posted. */
  postComment: (slug: string, issue: number, body: string) => Promise<boolean>;
  /** Optional structured logger. */
  log?: (message: string, context?: Record<string, unknown>) => void;
  /** Test seam: override slug resolution (default: origin-remote resolution). */
  resolveSlug?: SlugResolver;
}

/**
 * Post the APPROVAL_PROVENANCE comment for a fresh `granted` ISSUE-key result.
 *
 * Returns `void` and NEVER throws — every failure is caught and logged
 * (fail-soft: the grant already authorized the close, so a failed post degrades
 * to the pre-#3653 `close_without_provenance` audit state, never a broken
 * approval — R2). Emits ONLY on `granted` + `key.kind === "issue"` (R3): a
 * bypass `kind: "scope"` key has no issue target, and denied/overlap/(future)
 * `already-granted` results never reach a fresh mint. [directive #3653 Task 2]
 */
export async function emitGrantProvenance(
  result: VerifyResult,
  deps: EmitGrantProvenanceDeps
): Promise<void> {
  // R3 anti-forge guard: a fresh granted mint whose key is an issue, only.
  if (result.ok !== "granted" || result.key.kind !== "issue") return;
  const issue = result.key.issueNumber;
  const { grant } = result;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolveSlug = deps.resolveSlug ?? defaultResolveSlug;
    const slug = await resolveSlug(deps.repoPath);
    if (!slug) {
      // Repo resolution failed (origin is a fork/alias/non-GitHub URL, or no
      // remote). Logged no-op — never a throw (Open Risk: repo resolution).
      deps.log?.(
        `approval-token gate: provenance skipped for issue #${issue} — origin is not an owner/repo GitHub URL`,
        { hookId: APPROVAL_TOKEN_HOOK_ID }
      );
      return;
    }
    const body = buildProvenanceComment({
      approvedBy: grant.approved_by,
      phrase: grant.nonce,
      approvedAt: grant.minted_at,
      // grant.scope is the challenge's scope (registry §4.1): preserve `epic`
      // for an epic-parent token approval so a member close is authorized.
      scope: coerceProvenanceScope(grant.scope),
      repo: slug,
      issue,
    });
    // Own bound so a hung transport cannot leak past the budget. `.unref()` so a
    // pending timer never keeps the process alive; cleared when the post settles.
    const timeout = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), PROVENANCE_POST_TIMEOUT_MS);
      timer.unref?.();
    });
    const posted = await Promise.race([
      deps.postComment(slug, issue, body),
      timeout,
    ]);
    deps.log?.(
      `approval-token gate: provenance ${
        posted ? "posted" : "post FAILED (degraded to audit state)"
      } for ${slug}#${issue}`,
      { hookId: APPROVAL_TOKEN_HOOK_ID }
    );
  } catch (err) {
    // Fail-soft: never propagate (the grant already authorized the close).
    deps.log?.(
      `approval-token gate: provenance emit error for issue #${issue} (ignored): ${String(err)}`,
      { hookId: APPROVAL_TOKEN_HOOK_ID }
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DefaultPostCommentDeps {
  /** Injectable `gh` runner (default: real `Bun.spawn`). */
  runGh?: GhRunner;
  /** Injectable `fetch` for the REST fallback (default: real `fetch`). */
  fetchImpl?: FetchImpl;
  /** Env for the REST token lookup (default: `process.env`). */
  env?: Record<string, string | undefined>;
  /** Optional structured logger. */
  log?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Build the production comment poster: `gh` CLI first, token-backed REST
 * fallback — mirroring `stateBinding.defaultTargetDriftResolver` and the
 * "🔴 Fallback Preservation Rule". The `gh` arm is tried FIRST so the comment is
 * authored by the host's repo owner on RP1 and every federation peer (the
 * anti-forge author-allowlist guarantee — R3). A provisioned cloud VM has no
 * `gh` binary (every `Bun.spawn(["gh", …])` throws), so the REST arm posts with
 * the VM's `GH_TOKEN`; this is a robustness improvement, not AC-blocking (the
 * rp1-home gate only governs closes driven from rp1-home's `.claude/` skills,
 * which never run on a cloud VM). The arm used is logged on every post for
 * forensics (NEW-3653-15). Impure by design — lives in the hook module, never in
 * the pure `approvalTokens.ts`.
 */
export function createDefaultPostComment(
  deps: DefaultPostCommentDeps = {}
): (slug: string, issue: number, body: string) => Promise<boolean> {
  const runGh = deps.runGh ?? runGhWithBunSpawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const log = deps.log;

  return async (slug, issue, body) => {
    // Transport 1: `gh` CLI (tried first — owner identity on RP1/peers). A
    // missing binary THROWS (cloud VM); a non-zero exit falls through to REST.
    try {
      const { code, stderr } = await runGh([
        "gh",
        "issue",
        "comment",
        String(issue),
        "--repo",
        slug,
        "--body",
        body,
      ]);
      if (code === 0) {
        log?.(
          `approval-token gate: provenance posted via gh for ${slug}#${issue}`,
          {
            hookId: APPROVAL_TOKEN_HOOK_ID,
            arm: "gh",
          }
        );
        return true;
      }
      log?.(
        `approval-token gate: gh comment exited ${code} for ${slug}#${issue}; trying REST`,
        {
          hookId: APPROVAL_TOKEN_HOOK_ID,
          arm: "gh",
          stderr: stderr.slice(0, 200),
        }
      );
    } catch (err) {
      log?.(
        `approval-token gate: gh comment threw for ${slug}#${issue}; trying REST: ${String(err)}`,
        { hookId: APPROVAL_TOKEN_HOOK_ID, arm: "gh" }
      );
    }

    // Transport 2: token-backed REST (cloud VM — no `gh` binary). The token
    // never leaves this function.
    const token = resolveGitHubToken(env);
    if (!token) {
      log?.(
        `approval-token gate: provenance post unavailable for ${slug}#${issue} — gh failed and no GH_TOKEN/GITHUB_TOKEN`,
        { hookId: APPROVAL_TOKEN_HOOK_ID, arm: "rest" }
      );
      return false;
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `https://api.github.com/repos/${slug}/issues/${issue}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "hapimatic",
          },
          body: JSON.stringify({ body }),
          signal: AbortSignal.timeout(PROVENANCE_POST_TIMEOUT_MS),
        }
      );
    } catch (err) {
      log?.(
        `approval-token gate: provenance REST post threw for ${slug}#${issue} (ignored): ${String(err)}`,
        { hookId: APPROVAL_TOKEN_HOOK_ID, arm: "rest" }
      );
      return false;
    }
    const failure = classifyRestStatus(response);
    if (failure) {
      // On a user VM the GH_TOKEN is the VM user's wizard token, so this arm is
      // EXPECTED to fail the repo owner's author-allowlist (or 404 a private
      // repo). Logged, never thrown (NEW-3653-15).
      log?.(
        `approval-token gate: provenance REST post failed (${response.status}/${failure}) for ${slug}#${issue}`,
        { hookId: APPROVAL_TOKEN_HOOK_ID, arm: "rest", status: response.status }
      );
      return false;
    }
    log?.(
      `approval-token gate: provenance posted via REST for ${slug}#${issue}`,
      {
        hookId: APPROVAL_TOKEN_HOOK_ID,
        arm: "rest",
      }
    );
    return true;
  };
}

/** Render the state-overlap decision menu injected as context (ruling D1a).
 *  Takes a pre-rendered key LABEL (issue #N or scope <key>) so the same menu
 *  serves both the issue-scope and bypass-scope paths (#3538). */
function formatOverlapDecisionMenu(
  keyLabel: string,
  analysis: {
    collided_files: string[];
    incoming_change_description: string;
    plausible_interaction_assessment: string;
    recommendation: string;
    escalation_required: boolean;
  }
): string {
  const collided =
    analysis.collided_files.length > 0
      ? analysis.collided_files.map(f => `  - ${f}`).join("\n")
      : "  (none listed)";
  return [
    `⚠️ APPROVAL STATE OVERLAP — ${keyLabel}`,
    "",
    "The state you approved has drifted, and the incoming change overlaps the",
    "approved files. Per epic ruling D1a this is a DECISION, not an automatic",
    "denial — no grant has been minted. Present these options to the user:",
    "",
    `Collided files:\n${collided}`,
    "",
    `Incoming change: ${analysis.incoming_change_description}`,
    `Interaction assessment: ${analysis.plausible_interaction_assessment}`,
    `Recommendation: ${analysis.recommendation}`,
    `Escalation required: ${analysis.escalation_required ? "yes (human must decide)" : "no (mechanically rebaseable)"}`,
  ].join("\n");
}
