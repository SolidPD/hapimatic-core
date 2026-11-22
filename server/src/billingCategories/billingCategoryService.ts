// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLING_LOCAL_SOURCE,
  BillingCategoryListSchema,
  FederationBillingCategoryLookupAnswerSchema,
  TrackingCategoryUnavailableError,
  isBillingCurrency,
  type BillingCategoriesUnavailableReason,
  type BillingCategoryErrorBody,
  type BillingCategoryHistory,
  type BillingCategoryList,
  type BillingCategoryOwnerRef,
  type TrackingCategory,
  type TrackingCategoryLookup,
  type TrackingCategoryRef,
} from "@hapi/protocol";
import type { BillingCategoryOwnerView } from "../federation/nodeRegistry";
import type { PeerReadOutcome } from "../federation/nodeRegistry";
import {
  BillingCategoryWriteError,
  type BillingCategoryRateInput,
  type BillingCategoryState,
  type BillingCategoryStore,
} from "../store/billingCategoryStore";

/**
 * Issue #6779 (plan sections 3.4 and 5): where a billing-category request is
 * served, the read-through to the owner, and the lookup #6778 calls.
 *
 * `place()` runs on every call, from the registry's last poll. The owner
 * (by setting or rule) serves locally while no other node advertises the
 * owner tag; every other node reads the one advertiser's list through, once,
 * with no retry and no cache. Owner discovery fails closed: no owner, two
 * owners, an owner not yet polled or not reachable all refuse with a reason,
 * and a node never offers or validates against a list of its own when it is
 * not the owner. No message or log line built here carries a rate.
 */

export type BillingCategoryFailure = {
  reason: BillingCategoriesUnavailableReason;
  ownerNodeId?: string;
  ownerLabel?: string;
  owners?: BillingCategoryOwnerRef[];
};

export type BillingCategoryServicePlace =
  | { kind: "local" }
  | { kind: "remote"; ownerNodeId: string; ownerLabel: string }
  | ({ kind: "none" } & BillingCategoryFailure);

/** A route's refusal: its status and the error body (never a list or a rate). */
export type BillingCategoryRefusal = {
  status: 400 | 403 | 404 | 409 | 503;
  body: BillingCategoryErrorBody;
};

export type BillingCategoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: BillingCategoryRefusal };

/** The status and code for each reason (plan 3.4). */
export function unavailableRefusal(
  failure: BillingCategoryFailure
): BillingCategoryRefusal {
  const { reason } = failure;
  const status: 409 | 503 =
    reason === "no-owner" ||
    reason === "two-owners" ||
    reason === "owner-unsupported"
      ? 409
      : 503;
  const code =
    status === 409
      ? "categories_unavailable"
      : reason === "owner-not-polled"
        ? "categories_owner_not_reachable_yet"
        : reason === "storage-not-ready"
          ? "categories_storage_not_ready"
          : "categories_owner_unreachable";
  return {
    status,
    body: {
      code,
      reason,
      ...(failure.ownerNodeId !== undefined
        ? { ownerNodeId: failure.ownerNodeId, ownerLabel: failure.ownerLabel }
        : {}),
      ...(failure.owners ? { owners: failure.owners } : {}),
    },
  };
}

type RegistryReads = {
  getBillingCategoryOwnerViews(): BillingCategoryOwnerView[];
  listBillingCategoriesOnNode(
    nodeId: string,
    namespace: string,
    body: { includeRetired?: boolean }
  ): Promise<PeerReadOutcome>;
  lookupBillingCategoryOnNode(
    nodeId: string,
    namespace: string,
    ref: TrackingCategoryRef
  ): Promise<PeerReadOutcome>;
};

export type BillingCategoryServiceOptions = {
  store: {
    readonly billingCategories: BillingCategoryStore;
    readonly billingCategoriesReady: boolean;
  };
  getNodeRegistry: () => RegistryReads | null;
  /** This node's owner state, resolved once at boot (setting or rule). */
  getOwner: () => boolean;
  /** This node's federation identity, or null when it has no federation. */
  self: { nodeId: string; nodeLabel: string } | null;
  errorLogger?: {
    warn(
      message: string,
      options?: { category?: string; context?: Record<string, unknown> | null }
    ): void;
  } | null;
};

export type BillingCategoryWriteActor = {
  userAgent: string | null;
};

export type BillingCategoryWrite =
  | { op: "add"; name: string; defaultRate?: BillingCategoryRateInput | null }
  | {
      op: "update";
      id: string;
      name?: string;
      defaultRate?: BillingCategoryRateInput | null;
      retired?: boolean;
    }
  | { op: "order"; ids: string[] }
  | { op: "settings"; defaultCategoryId?: string; currency?: string };

const NOT_LOCAL_CODE = "categories_not_local";
const ANSWER_SCHEMA = BillingCategoryListSchema.omit({ place: true });

export class BillingCategoryService {
  private readonly loggedTwoOwnerSets = new Set<string>();

  constructor(private readonly options: BillingCategoryServiceOptions) {}

  /** This node owns the list (by setting or rule) and its storage is ready. */
  isReadyOwner(): boolean {
    return this.options.getOwner() && this.options.store.billingCategoriesReady;
  }

  /** Where a request is served, from the registry's last poll (plan 3.4). */
  place(): BillingCategoryServicePlace {
    const views =
      this.options.getNodeRegistry()?.getBillingCategoryOwnerViews() ?? [];
    // A node marked offline that still carries the tag counts (reading R-2).
    const advertisers = views.filter(view => view.owner);
    if (this.options.getOwner()) {
      if (!this.options.store.billingCategoriesReady) {
        return { kind: "none", reason: "storage-not-ready" };
      }
      if (advertisers.length === 0) return { kind: "local" };
      const self = this.options.self ?? { nodeId: "", nodeLabel: "" };
      return this.twoOwners([
        { nodeId: self.nodeId, nodeLabel: self.nodeLabel },
        ...advertisers.map(ownerRef),
      ]);
    }
    if (advertisers.length > 1) {
      return this.twoOwners(advertisers.map(ownerRef));
    }
    if (advertisers.length === 1) {
      const owner = advertisers[0]!;
      if (owner.status === "offline") {
        return {
          kind: "none",
          reason: "owner-offline",
          ownerNodeId: owner.nodeId,
          ownerLabel: owner.nodeLabel,
        };
      }
      return {
        kind: "remote",
        ownerNodeId: owner.nodeId,
        ownerLabel: owner.nodeLabel,
      };
    }
    if (views.some(view => view.awaitingInitialPoll)) {
      return { kind: "none", reason: "owner-not-polled" };
    }
    return { kind: "none", reason: "no-owner" };
  }

  private twoOwners(
    owners: BillingCategoryOwnerRef[]
  ): BillingCategoryServicePlace {
    const key = owners
      .map(owner => owner.nodeId)
      .sort()
      .join(",");
    if (!this.loggedTwoOwnerSets.has(key)) {
      this.loggedTwoOwnerSets.add(key);
      this.options.errorLogger?.warn(
        "Billing categories: more than one node owns the list; categories are closed until one has billingCategories.owner false or its gate off",
        { category: "billing-categories-two-owners", context: { owners } }
      );
    }
    return { kind: "none", reason: "two-owners", owners };
  }

  /** The list, locally or through the owner (R7, R13). */
  async readList(
    namespace: string,
    opts: { includeRetired?: boolean } = {}
  ): Promise<BillingCategoryResult<BillingCategoryList>> {
    const place = this.place();
    if (place.kind === "local") {
      return { ok: true, value: this.readListLocal(namespace, opts) };
    }
    if (place.kind === "none") {
      return { ok: false, refusal: unavailableRefusal(place) };
    }
    const registry = this.options.getNodeRegistry();
    const outcome = registry
      ? await registry.listBillingCategoriesOnNode(
          place.ownerNodeId,
          namespace,
          { includeRetired: opts.includeRetired === true }
        )
      : ({ kind: "offline" } as const);
    if (outcome.kind !== "ok") {
      this.warnReadThrough("list", place.ownerNodeId, outcome);
      return {
        ok: false,
        refusal: unavailableRefusal(remoteFailure(outcome, place)),
      };
    }
    // The reader writes its own `place`, so the owner's is not read: an owner
    // that adds a place kind never closes the list on an older reader.
    const parsed = ANSWER_SCHEMA.safeParse(outcome.body);
    // An owner's answer always names a category of the list it sends; only a
    // reader's OWN answer may carry a null default (#6779 review H1).
    const defaultId = parsed.success
      ? parsed.data.local.defaultCategoryId
      : null;
    const badDefault =
      parsed.success &&
      !parsed.data.local.categories.some(category => category.id === defaultId);
    if (!parsed.success || badDefault) {
      this.warnReadThrough("list", place.ownerNodeId, {
        kind: "malformed",
        paths: parsed.success
          ? ["local.defaultCategoryId"]
          : parsed.error.issues.map(issue => issue.path.join(".")),
      });
      return {
        ok: false,
        refusal: unavailableRefusal(ownerFailure("owner-unreachable", place)),
      };
    }
    // A rate this build cannot interpret is never guessed at (the Project
    // Manager's ruling of 2026-11-19): such a category is not offered here.
    const unknown = new Set<string>();
    const leftOut = new Set<string>();
    const categories = parsed.data.local.categories.filter(category => {
      const currency = category.defaultRate?.currency;
      if (currency === undefined || isBillingCurrency(currency)) return true;
      unknown.add(currency);
      leftOut.add(category.id);
      return false;
    });
    // The answer never names a default it leaves out: no default here, so
    // nothing is prefilled on this node and a person picks a category.
    const defaultLeftOut =
      parsed.data.local.defaultCategoryId !== null &&
      leftOut.has(parsed.data.local.defaultCategoryId);
    this.warnUnknownCurrencies(unknown, defaultLeftOut);
    // The owner's currency for a new rate is the owner's: passed on unchanged,
    // never guessed at; a code this table lacks is only named (#6779 review F1).
    if (!isBillingCurrency(parsed.data.currency)) {
      this.warnUnknownListCurrency(parsed.data.currency);
    }
    return {
      ok: true,
      value: {
        ...parsed.data,
        local: {
          ...parsed.data.local,
          defaultCategoryId: defaultLeftOut
            ? null
            : parsed.data.local.defaultCategoryId,
          categories,
        },
        place: {
          kind: "owner",
          nodeId: place.ownerNodeId,
          nodeLabel: place.ownerLabel,
        },
      },
    };
  }

  /** The owner's own list; the receivers call this, never `readList`. */
  readListLocal(
    namespace: string,
    opts: { includeRetired?: boolean } = {}
  ): BillingCategoryList {
    return toListAnswer(
      this.options.store.billingCategories.read(namespace, {
        includeRetired: opts.includeRetired === true,
      })
    );
  }

  /** The owner's own lookup; the receivers call this, never `lookupFor`. */
  lookupLocal(
    namespace: string,
    ref: TrackingCategoryRef
  ): TrackingCategory | null {
    if (ref.source !== BILLING_LOCAL_SOURCE) return null;
    return this.options.store.billingCategories.getLocal(namespace, ref.id);
  }

  /**
   * The lookup #6778 calls (section 5). Always a lookup while the service
   * exists; `get()` reads the place when it runs and rejects with the reason.
   */
  lookupFor(namespace: string): TrackingCategoryLookup {
    return {
      get: async (ref: TrackingCategoryRef) => {
        const place = this.place();
        if (place.kind === "local") return this.lookupLocal(namespace, ref);
        if (place.kind === "none") {
          throw new TrackingCategoryUnavailableError(place.reason);
        }
        const registry = this.options.getNodeRegistry();
        const outcome = registry
          ? await registry.lookupBillingCategoryOnNode(
              place.ownerNodeId,
              namespace,
              ref
            )
          : ({ kind: "offline" } as const);
        if (outcome.kind !== "ok") {
          this.warnReadThrough("lookup", place.ownerNodeId, outcome);
          throw new TrackingCategoryUnavailableError(
            remoteFailure(outcome, place).reason
          );
        }
        const parsed = FederationBillingCategoryLookupAnswerSchema.safeParse(
          outcome.body
        );
        if (!parsed.success) {
          this.warnReadThrough("lookup", place.ownerNodeId, {
            kind: "malformed",
            paths: parsed.error.issues.map(issue => issue.path.join(".")),
          });
          throw new TrackingCategoryUnavailableError("owner-unreachable");
        }
        if (!parsed.data.found) return null;
        const category = parsed.data.category;
        // A hit must answer the ref asked for (review F6).
        if (category.source !== ref.source || category.id !== ref.id) {
          throw new TrackingCategoryUnavailableError("owner-unreachable");
        }
        // A rate this build cannot interpret: answered as not offered, so a
        // new pick is refused here and a record that keeps it is untouched.
        if (
          category.defaultCurrency !== null &&
          !isBillingCurrency(category.defaultCurrency)
        ) {
          this.warnUnknownCurrencies(new Set([category.defaultCurrency]));
          return { ...category, offered: false };
        }
        return category;
      },
    };
  }

  /**
   * One log line per failed read through the owner: the node, the outcome's
   * reason, status and code, or a malformed body's paths. Never the outcome's
   * message or the body, which can quote the owner's answer.
   */
  private warnReadThrough(
    read: "list" | "lookup",
    ownerNodeId: string,
    outcome:
      | Exclude<PeerReadOutcome, { kind: "ok" }>
      | { kind: "malformed"; paths: string[] }
  ): void {
    const detail =
      outcome.kind === "unreachable"
        ? {
            reason: outcome.reason,
            status: outcome.status ?? null,
            code: outcome.code ?? null,
          }
        : outcome.kind === "malformed"
          ? { reason: "schema", paths: outcome.paths.slice(0, 5) }
          : { reason: outcome.kind };
    this.options.errorLogger?.warn(
      `Billing categories: the ${read} read through ${ownerNodeId} failed (${detail.reason})`,
      {
        category: "billing-categories-read-through",
        context: { ownerNodeId, read, ...detail },
      }
    );
  }

  /** One log line per read that met currency codes this build lacks (no rate). */
  private warnUnknownCurrencies(
    codes: Set<string>,
    defaultLeftOut = false
  ): void {
    if (codes.size === 0) return;
    this.options.errorLogger?.warn(
      `Billing categories: the owner's list holds currency ${[...codes].sort().join(", ")}, which this node's ISO 4217 table lacks (this node's build is older than the owner's table); those categories are not offered here${defaultLeftOut ? ", and the default category is one of them, so this node has no default" : ""}`,
      { category: "billing-categories-unknown-currency" }
    );
  }

  /** The same line for the owner's currency for a new rate: the code only. */
  private warnUnknownListCurrency(code: string): void {
    this.options.errorLogger?.warn(
      `Billing categories: the owner's currency for a new rate is ${code}, which this node's ISO 4217 table lacks (this node's build is older than the owner's table); it is passed on as the owner's and not read here`,
      { category: "billing-categories-unknown-currency" }
    );
  }

  /** A write, on the owner only (else 409 `categories_on_hub`). */
  write(
    namespace: string,
    token: number,
    actor: BillingCategoryWriteActor,
    change: BillingCategoryWrite
  ): BillingCategoryResult<BillingCategoryList> {
    const refusal = this.writeRefusal();
    if (refusal) return { ok: false, refusal };
    const store = this.options.store.billingCategories;
    const ctx = {
      namespace,
      token,
      actor: { kind: "client" as const, userAgent: actor.userAgent },
      entryNodeId: this.options.self?.nodeId ?? null,
    };
    try {
      let state: BillingCategoryState;
      if (change.op === "add") {
        state = store.add(ctx, change);
      } else if (change.op === "update") {
        const { id, ...rest } = change;
        state = store.update(ctx, id, rest);
      } else if (change.op === "order") {
        state = store.reorder(ctx, change.ids);
      } else {
        state = store.setSettings(ctx, change);
      }
      return { ok: true, value: toListAnswer(state) };
    } catch (error) {
      if (error instanceof BillingCategoryWriteError) {
        return {
          ok: false,
          refusal: {
            status: error.status,
            body: { code: error.code, ...error.details },
          },
        };
      }
      throw error;
    }
  }

  /** The history, on the owner only (else 409 `categories_on_hub`). */
  history(
    namespace: string,
    opts: { limit?: number; before?: number }
  ): BillingCategoryResult<BillingCategoryHistory> {
    const refusal = this.writeRefusal();
    if (refusal) return { ok: false, refusal };
    return {
      ok: true,
      value: this.options.store.billingCategories.history(namespace, opts),
    };
  }

  /** The refusal a write or the history gets here, or null on the owner. */
  writeRefusal(): BillingCategoryRefusal | null {
    const place = this.place();
    if (place.kind === "local") return null;
    if (place.kind === "remote") {
      return {
        status: 409,
        body: {
          code: "categories_on_hub",
          ownerNodeId: place.ownerNodeId,
          ownerLabel: place.ownerLabel,
        },
      };
    }
    return unavailableRefusal(place);
  }
}

function ownerRef(view: BillingCategoryOwnerView): BillingCategoryOwnerRef {
  return { nodeId: view.nodeId, nodeLabel: view.nodeLabel };
}

function ownerFailure(
  reason: BillingCategoriesUnavailableReason,
  place: { ownerNodeId: string; ownerLabel: string }
): BillingCategoryFailure {
  return {
    reason,
    ownerNodeId: place.ownerNodeId,
    ownerLabel: place.ownerLabel,
  };
}

/** A failed read through the owner, mapped to its reason (plan 3.4's table). */
function remoteFailure(
  outcome: Exclude<PeerReadOutcome, { kind: "ok" }>,
  place: { ownerNodeId: string; ownerLabel: string }
): BillingCategoryFailure {
  if (outcome.kind === "offline") return ownerFailure("owner-offline", place);
  if (outcome.kind === "unsupported") {
    return ownerFailure("owner-unsupported", place);
  }
  if (outcome.status === 409 && outcome.code === NOT_LOCAL_CODE) {
    // The only owner this node sees sees a second owner (X4).
    return {
      ...ownerFailure("two-owners", place),
      owners: [{ nodeId: place.ownerNodeId, nodeLabel: place.ownerLabel }],
    };
  }
  return ownerFailure("owner-unreachable", place);
}

function toListAnswer(state: BillingCategoryState): BillingCategoryList {
  return {
    token: state.token,
    currency: state.currency,
    place: { kind: "local" },
    local: {
      defaultCategoryId: state.defaultCategoryId,
      categories: state.categories,
    },
  };
}

/**
 * The lookup helper #6778's own pull request passes to its three validating
 * factories (P-8). Answers null only when there is no service.
 */
export function createTrackingCategoryLookupGetter(
  getService: () => BillingCategoryService | null
): (namespace: string) => TrackingCategoryLookup | null {
  return namespace => getService()?.lookupFor(namespace) ?? null;
}
