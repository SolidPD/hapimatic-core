// SPDX-License-Identifier: AGPL-3.0-only
import {
  BILLING_CATEGORIES_OWNER_CAPABILITY,
  type BillableSwitchMode,
} from "@hapi/protocol";

/**
 * Issue #6779 (P-3 = 1): which node keeps the billing-category list, the owner
 * (the billing hub). The rule plus an explicit setting, the shape of
 * `throughput.fleetJobs` and its override (`server/src/throughput/config.ts`):
 * `settings.billingCategories.owner` `true` makes this node an owner, `false`
 * a reader, and unset applies the rule "no federation, or the hub". Resolved
 * once at boot. A value that is not a boolean is treated as unset and named in
 * the boot line. A node whose setting is `false` never serves a list of its
 * own, even standalone (it is then ownerless and closed).
 */
export type BillingCategoriesOwnerReason =
  | "setting-true"
  | "setting-false"
  | "standalone"
  | "hub"
  | "not-hub";

export type BillingCategoriesOwnerState = {
  owner: boolean;
  reason: BillingCategoriesOwnerReason;
  /** True when the setting held a value that is not a boolean. */
  settingIgnored: boolean;
};

export function resolveBillingCategoriesOwner(input: {
  federationRole: "hub" | "node" | "peer" | null;
  ownerSetting: unknown;
}): BillingCategoriesOwnerState {
  const { federationRole, ownerSetting } = input;
  if (ownerSetting === true) {
    return { owner: true, reason: "setting-true", settingIgnored: false };
  }
  if (ownerSetting === false) {
    return { owner: false, reason: "setting-false", settingIgnored: false };
  }
  const settingIgnored = ownerSetting !== undefined && ownerSetting !== null;
  if (federationRole === null) {
    return { owner: true, reason: "standalone", settingIgnored };
  }
  if (federationRole === "hub") {
    return { owner: true, reason: "hub", settingIgnored };
  }
  return { owner: false, reason: "not-hub", settingIgnored };
}

/**
 * The owner tag, only when this node is the owner, its category storage is
 * ready and its billable gate is `on` or `closed` (an owner whose gate is off
 * is fully off, P-6).
 */
export function billingCategoriesCapabilityTags(
  state:
    | { owner: boolean; storageReady: boolean; mode: BillableSwitchMode }
    | undefined
): string[] {
  if (!state) return [];
  return state.owner &&
    state.storageReady &&
    (state.mode === "on" || state.mode === "closed")
    ? [BILLING_CATEGORIES_OWNER_CAPABILITY]
    : [];
}

/**
 * The one boot line: where the list is kept, and why. With the billable gate
 * off or closed it names the gate, so "kept here" never reads as "in use"
 * (#6779 review F2); boot passes the gate's mode.
 */
export function describeBillingCategoriesOwner(
  state: BillingCategoriesOwnerState,
  mode?: BillableSwitchMode
): string {
  const where: Record<BillingCategoriesOwnerReason, string> = {
    "setting-true": "kept here (setting)",
    "setting-false": "read through from the owner (setting: false)",
    standalone: "kept here (no federation)",
    hub: "kept here (hub)",
    "not-hub": "read through from the owner (not the hub)",
  };
  const ignored = state.settingIgnored
    ? "; billingCategories.owner is not true or false, so it was treated as unset"
    : "";
  const gate =
    mode === "off"
      ? "; not in use while the billable switch is off"
      : mode === "closed"
        ? "; read only while the billable switch is closed"
        : "";
  return `[Server] Billing categories: ${where[state.reason]}${gate}${ignored}`;
}
