// SPDX-License-Identifier: AGPL-3.0-only
import {
  bindingRefForTarget,
  isCreditUnreadable,
  isUsableNodeIdForSharing,
  LOCAL_NODE_ID,
  parseApiKeyRef,
  type FederationConfig,
} from "@hapi/protocol";
import {
  maskApiKey,
  StoredApiKeySchema,
  type AvailableApiKey,
  type AvailableApiKeysResponse,
  type AvailableApiKeysUnavailableReason,
  type RedactedApiKey,
  type StoredApiKey,
} from "@hapi/protocol/schemas";
import { isTenantVm as defaultIsTenantVm } from "@hapi/protocol/tenantMode";
import { readSettings } from "../config/settings";
import type {
  ApiKeyCallOutcome,
  NodeRegistry,
} from "../federation/nodeRegistry";
import type { ErrorLogger } from "../logging/errorLogger";
import { createDegradedLog } from "../web/routes/federation/degradedLog";
import {
  createApiKeyViewer,
  createCreditWorkLog,
  SHARED_LIST_CREDIT_DEADLINE_MS,
  type ApiKeySpendSource,
  type ApiKeyViewer,
} from "../web/routes/apiKeys";

/**
 * Shared API keys, requesting side (issue #5127).
 *
 * A Claude Code session binds a key by reference (`@hapi/protocol` apiKeyRef):
 * a bare id is a key in this node's vault; `<uuid>@<homeNodeId>` is a key in
 * another node's vault, read from there on demand. This service is the one
 * place this node turns a reference into a decision:
 *
 * - `resolve` — the key's non-secret identity, for the spawn-time check, the
 *   launcher's per-launch check and the picker. A local key reads the vault; a
 *   foreign key asks its home.
 * - `fetchSecret` — the key itself, for the session's `apiKeyHelper`. Foreign
 *   keys only: the helper reads a local key from the vault without the server.
 * - `listAvailable` — every key the Create-page picker may bind for a target.
 *
 * Every refusal names the home node by this node's label for it, so a session
 * that cannot start says where its key lives (R8). Nothing here falls back to
 * an account: a refusal is final.
 */

export type ApiKeyRefusal = {
  ok: false;
  code: string;
  message: string;
  /** The status a route answers with when it does not use the 200 envelope. */
  httpStatus: 400 | 403 | 404 | 409 | 503;
};

export type ResolvedApiKey = {
  ok: true;
  /** The ref the session stores: the bare id for a key on this node. */
  canonicalRef: string;
  label: string | null;
  maskedKey: string;
  homeNodeId: string;
  homeNodeLabel: string;
};

export type SharedApiKeyServiceOptions = {
  getSettingsFile: () => string;
  getFederationConfig: () => FederationConfig | null;
  getNodeRegistry: () => NodeRegistry | null;
  isTenantVm?: () => boolean;
  errorLogger?: ErrorLogger | null;
  /** #6789: this node's metered spend per key, for the picker's credit. Absent
   *  ⇒ every budgeted key answers `creditUnavailable` ("No estimate"), so a
   *  wiring gap shows instead of reading as a key with no budget. */
  getApiKeySpend?: ApiKeySpendSource;
  /** #6789 test seam: the wall clock for the budget arithmetic. */
  now?: () => number;
  /** #6789 test seam: the monotonic clock of the credit deadline. */
  clock?: () => number;
};

/** #6789: an older home's key (its answer has no `"credit"` in `includes`):
 *  whatever credit it carried is dropped, and a key with a budget or a top-up
 *  says it has no reading. A key with neither shows the no-budget state, as it
 *  would on its own node. */
function withoutHomeCredit(key: RedactedApiKey): RedactedApiKey {
  const {
    budgetStatus: _budgetStatus,
    outOfCredit: _outOfCredit,
    creditUnavailable: _creditUnavailable,
    ...rest
  } = key;
  return rest.budget !== undefined || rest.budgetRecurrence !== undefined
    ? { ...rest, creditUnavailable: true }
    : rest;
}

const refusal = (
  code: string,
  message: string,
  httpStatus: ApiKeyRefusal["httpStatus"]
): ApiKeyRefusal => ({ ok: false, code, message, httpStatus });

function keyName(entry: StoredApiKey): string {
  return entry.label?.trim()
    ? `"${entry.label.trim()}"`
    : maskApiKey(entry.key);
}

export class SharedApiKeyService {
  private readonly opts: SharedApiKeyServiceOptions;
  private readonly isTenant: () => boolean;
  private readonly degraded;
  private readonly viewer: ApiKeyViewer;
  private readonly creditWorkLog;

  constructor(opts: SharedApiKeyServiceOptions) {
    this.opts = opts;
    this.isTenant = opts.isTenantVm ?? (() => defaultIsTenantVm());
    this.degraded = createDegradedLog({ errorLogger: opts.errorLogger });
    const logger = opts.errorLogger;
    this.viewer = createApiKeyViewer({
      getApiKeySpend: opts.getApiKeySpend,
      now: opts.now,
      clock: opts.clock,
      warn: logger ? (m, o) => logger.warn(m, o) : undefined,
    });
    this.creditWorkLog = createCreditWorkLog((m, o) =>
      logger ? logger.log("warn", m, o) : console.warn(`[${o.category}]`, m)
    );
  }

  /** This node's own id, when it can share keys under it. */
  selfNodeId(): string | null {
    const cfg = this.opts.getFederationConfig();
    if (!cfg?.enabled) return null;
    return isUsableNodeIdForSharing(cfg.nodeId) ? cfg.nodeId : null;
  }

  private selfLabel(): string {
    const cfg = this.opts.getFederationConfig();
    return cfg?.nodeLabel?.trim() || cfg?.nodeId || "this node";
  }

  private homeLabel(homeNodeId: string): string {
    return (
      this.opts.getNodeRegistry()?.nodeLabelForIdentity(homeNodeId) ??
      homeNodeId
    );
  }

  private async readVault(): Promise<StoredApiKey[] | null> {
    const settings = await readSettings(this.opts.getSettingsFile());
    if (!settings || typeof settings !== "object") return null;
    const out: StoredApiKey[] = [];
    for (const raw of Array.isArray(settings.apiKeys) ? settings.apiKeys : []) {
      const parsed = StoredApiKeySchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  /**
   * Resolve a reference to its non-secret identity. A bare id, or a qualified
   * ref homed on this node, checks this node's vault (no share needed: the key
   * never leaves). A foreign ref asks the home. `requireShared` (the remote
   * spawn receiver) also refuses a key of this node's that is not shared: a
   * session another node starts here may bill only a shared key.
   */
  async resolve(
    ref: string,
    expectedMasked?: string,
    opts: { requireShared?: boolean; sessionId?: string } = {}
  ): Promise<ResolvedApiKey | ApiKeyRefusal> {
    const parsed = parseApiKeyRef(ref);
    if (!parsed) {
      return refusal(
        "api_key_ref_invalid",
        "The API key reference is malformed",
        400
      );
    }
    const selfId = this.selfNodeId();
    if (parsed.homeNodeId === null || parsed.homeNodeId === selfId) {
      return this.resolveLocal(
        parsed.id,
        expectedMasked,
        opts.requireShared === true
      );
    }
    const home = parsed.homeNodeId;
    const pre = this.foreignPrecheck(home);
    if (pre) return pre;
    const registry = this.opts.getNodeRegistry() as NodeRegistry;
    const outcome = await registry.resolveApiKeyOnNode(home, {
      id: parsed.id,
      ...(expectedMasked !== undefined ? { expectedMasked } : {}),
      // The home audits the session this check is for (R10).
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    });
    if (outcome.kind !== "ok") return this.mapOutcome(home, outcome);
    return {
      ok: true,
      canonicalRef: ref,
      label: outcome.value.label ?? null,
      maskedKey: outcome.value.maskedKey,
      homeNodeId: home,
      homeNodeLabel: this.homeLabel(home),
    };
  }

  /**
   * The secret of a FOREIGN key, for a session's helper. Refuses a local ref:
   * the helper reads a local key from the vault itself.
   */
  async fetchSecret(
    ref: string,
    expectedMasked: string,
    sessionId: string
  ): Promise<{ ok: true; apiKey: string } | ApiKeyRefusal> {
    const parsed = parseApiKeyRef(ref);
    if (!parsed) {
      return refusal(
        "api_key_ref_invalid",
        "The API key reference is malformed",
        400
      );
    }
    if (parsed.homeNodeId === null || parsed.homeNodeId === this.selfNodeId()) {
      return refusal(
        "api_key_local_ref",
        "This key is stored on this node; read it from the vault",
        400
      );
    }
    const home = parsed.homeNodeId;
    const pre = this.foreignPrecheck(home);
    if (pre) return pre;
    const registry = this.opts.getNodeRegistry() as NodeRegistry;
    const outcome = await registry.fetchApiKeySecretOnNode(home, {
      id: parsed.id,
      expectedMasked,
      sessionId,
    });
    if (outcome.kind !== "ok") return this.mapOutcome(home, outcome);
    return { ok: true, apiKey: outcome.value.apiKey };
  }

  /** Refusals a foreign ref gets before any request: a hosted VM, no
   *  federation, an unknown home. */
  private foreignPrecheck(home: string): ApiKeyRefusal | null {
    if (this.isTenant()) {
      return refusal(
        "tenant_vm",
        "A hosted VM uses only the API keys stored on it",
        403
      );
    }
    const registry = this.opts.getNodeRegistry();
    if (!this.selfNodeId() || !registry || !registry.knowsNode(home)) {
      return refusal(
        "api_key_home_unknown",
        `This node does not know ${home}, where this API key is stored`,
        404
      );
    }
    return null;
  }

  private async resolveLocal(
    id: string,
    expectedMasked?: string,
    requireShared = false
  ): Promise<ResolvedApiKey | ApiKeyRefusal> {
    const vault = await this.readVault();
    if (!vault) {
      return refusal(
        "api_key_vault_unreadable",
        `The API-key vault on ${this.selfLabel()} cannot be read`,
        503
      );
    }
    const entry = vault.find(e => e.id === id);
    if (!entry || entry.provider !== "anthropic") {
      return refusal(
        "api_key_not_found",
        `This API key is no longer stored on ${this.selfLabel()}`,
        404
      );
    }
    if (requireShared && entry.shareAcrossNodes !== true) {
      // Not named (as the home receivers do): a peer learns no label of a key
      // it was never offered.
      return refusal(
        "api_key_not_shared",
        `That API key on ${this.selfLabel()} is not shared with other nodes`,
        409
      );
    }
    if (
      expectedMasked !== undefined &&
      expectedMasked !== maskApiKey(entry.key)
    ) {
      return refusal(
        "api_key_changed",
        `The API key ${keyName(entry)} on ${this.selfLabel()} was replaced; pick it again`,
        409
      );
    }
    return {
      ok: true,
      canonicalRef: entry.id,
      label: entry.label ?? null,
      maskedKey: maskApiKey(entry.key),
      homeNodeId: this.selfNodeId() ?? LOCAL_NODE_ID,
      homeNodeLabel: this.selfLabel(),
    };
  }

  /** Every non-ok outcome as a refusal naming the home (the R8 messages). */
  private mapOutcome(
    home: string,
    outcome: Exclude<ApiKeyCallOutcome<unknown>, { kind: "ok" }>
  ): ApiKeyRefusal {
    const label = this.homeLabel(home);
    switch (outcome.kind) {
      case "unknown_node":
        return refusal(
          "api_key_home_unknown",
          `This node does not know ${label}, where this API key is stored`,
          404
        );
      case "offline":
        return refusal(
          "api_key_home_offline",
          `${label}, where this API key is stored, is offline — start the session when it is back, or pick another key or an account`,
          503
        );
      case "unsupported":
        return refusal(
          "api_key_home_unsupported",
          `${label} needs updating before its keys can be used here`,
          503
        );
      case "transport":
        return refusal(
          "api_key_home_transport",
          `${label} is reached over the public internet; keys stored there can be shared only over Tailscale`,
          503
        );
      case "refused": {
        const status =
          outcome.code === "api_key_not_found"
            ? 404
            : outcome.code === "api_key_not_shared" ||
                outcome.code === "api_key_changed"
              ? 409
              : 503;
        return refusal(outcome.code, outcome.message, status);
      }
      case "error":
        return refusal(
          "api_key_home_error",
          `${label}, where this API key is stored, could not be asked for it: ${outcome.message}`,
          503
        );
    }
    return refusal(
      "api_key_home_error",
      `${label}, where this API key is stored, could not be asked for it`,
      503
    );
  }

  /**
   * Every key the picker may bind when spawning on `targetNodeId` (null, this
   * node's id, or `LOCAL_NODE_ID` = this node). This node's own Anthropic keys
   * appear for a local target (all of them) or a remote one (only the shared
   * ones, D8); every capable peer's shared keys appear for any target. Peers that
   * cannot be read are listed in `unavailableNodes`, never silently dropped.
   */
  async listAvailable(
    targetNodeId: string | null
  ): Promise<AvailableApiKeysResponse> {
    const vault = (await this.readVault()) ?? [];
    // #6789 (DEC-3): this node's own keys get the same credit deadline as a
    // home's shared list, started after the vault read as the home's is;
    // nothing is memoized.
    const creditStarted = this.viewer.clock();
    const creditDeadlineAtMs = creditStarted + SHARED_LIST_CREDIT_DEADLINE_MS;
    let creditSkipped = 0;
    /** One spend reader for the list (Task 6, rung 2), same order as given. */
    const views = (entries: readonly StoredApiKey[]): RedactedApiKey[] =>
      this.viewer.listView(entries, {
        creditDeadlineAtMs,
        onCreditDeadline: () => {
          creditSkipped += 1;
        },
      });
    const reportCredit = (): void =>
      this.creditWorkLog("available", {
        skipped: creditSkipped,
        elapsedMs: this.viewer.clock() - creditStarted,
      });
    const selfId = this.selfNodeId();
    const target =
      targetNodeId === null ||
      targetNodeId === LOCAL_NODE_ID ||
      targetNodeId === selfId
        ? null
        : targetNodeId;
    const localAnthropic = vault.filter(e => e.provider === "anthropic");

    const registry = this.opts.getNodeRegistry();
    if (!selfId || this.isTenant() || !registry) {
      // No federation to share over: local keys only, bare refs.
      const offered = target === null ? localAnthropic : [];
      const offeredViews = views(offered);
      const keys: AvailableApiKey[] = offered.map((e, i) => ({
        ...offeredViews[i]!,
        homeNodeId: LOCAL_NODE_ID,
        homeNodeLabel: this.selfLabel(),
        local: true,
        bindingRef: e.id,
      }));
      reportCredit();
      return { localNodeId: null, keys, unavailableNodes: [] };
    }

    const ctx = { uiNodeId: selfId, targetNodeId: target ?? selfId };
    const offered = localAnthropic.filter(
      e => target === null || e.shareAcrossNodes === true
    );
    const offeredViews = views(offered);
    const keys: AvailableApiKey[] = offered.map((e, i) => ({
      ...offeredViews[i]!,
      homeNodeId: selfId,
      homeNodeLabel: this.selfLabel(),
      local: true,
      bindingRef: bindingRefForTarget({ id: e.id, homeNodeId: selfId }, ctx),
    }));
    // The local work is done before the peers are asked; their requests leave
    // only once it yields either way (`apiKeyCall` awaits `homeUrlGuard` before
    // its fetch), so the deadline is what bounds it.
    reportCredit();

    const unavailableNodes: AvailableApiKeysResponse["unavailableNodes"] = [];
    const summaries = registry.getNodeSummaries();
    const results = await Promise.allSettled(
      summaries.map(s => registry.listSharedApiKeysOnNode(s.nodeId))
    );
    results.forEach((result, i) => {
      const summary = summaries[i];
      if (!summary) return;
      const reason: AvailableApiKeysUnavailableReason | null =
        result.status === "rejected"
          ? "error"
          : result.value.kind === "ok"
            ? null
            : result.value.kind === "offline"
              ? "offline"
              : result.value.kind === "unsupported"
                ? "unsupported"
                : result.value.kind === "transport"
                  ? "transport"
                  : "error";
      if (reason !== null || result.status !== "fulfilled") {
        unavailableNodes.push({
          nodeId: summary.nodeId,
          nodeLabel: summary.nodeLabel,
          reason: reason ?? "error",
        });
        if (reason === "error" || reason === "transport") {
          this.degraded.warn(
            summary.nodeId,
            reason,
            `Shared API keys on ${summary.nodeLabel} could not be listed`,
            { nodeId: summary.nodeId, reason }
          );
        } else if (
          reason === "offline" &&
          (summary.status === "online" || summary.status === "degraded")
        ) {
          // #6789: up at the last poll, but no answer in time (a timeout maps
          // to "offline"): a slow home, not a down one.
          this.degraded.warn(
            summary.nodeId,
            reason,
            `Shared API keys on ${summary.nodeLabel} did not answer in time`,
            { nodeId: summary.nodeId, reason }
          );
        }
        return;
      }
      this.degraded.ok(summary.nodeId);
      const value = result.value;
      if (value.kind !== "ok") return;
      const home = value.value.homeNodeId;
      if (!isUsableNodeIdForSharing(home) || home === selfId) return;
      // #6789: a home that reports credit says so in its answer; an older
      // home's keys carry no reading this node can trust.
      const homeReportsCredit =
        value.value.includes?.includes("credit") === true;
      for (const k of value.value.keys) {
        if (k.provider !== "anthropic") continue;
        keys.push({
          ...(homeReportsCredit ? k : withoutHomeCredit(k)),
          homeNodeId: home,
          homeNodeLabel: summary.nodeLabel,
          local: false,
          bindingRef: bindingRefForTarget({ id: k.id, homeNodeId: home }, ctx),
        });
      }
      // #6789 (closer, adjacent): say once per home when a credit value
      // could not be read, so "No estimate" on its keys has a cause on record.
      const unreadable = value.value.keys.filter(isCreditUnreadable).length;
      if (unreadable > 0) {
        this.degraded.warn(
          `${summary.nodeId}:credit`,
          "credit-unreadable",
          `Credit on ${summary.nodeLabel} could not be read for ${unreadable} shared key(s)`,
          {
            nodeId: summary.nodeId,
            reason: "credit-unreadable",
            keys: unreadable,
          }
        );
      } else this.degraded.ok(`${summary.nodeId}:credit`);
    });

    return { localNodeId: selfId, keys, unavailableNodes };
  }
}
