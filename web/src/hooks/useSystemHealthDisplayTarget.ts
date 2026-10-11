// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";
import { getStatusColor } from "@/lib/systemHealth";
import { useHealthStatus } from "@/hooks/queries/useHealthStatus";
import { useAdminPreferences } from "./useAdminPreferences";
import { useFederatedSessions } from "./queries/useFederatedSessions";
import {
  useFederationHealthAggregate,
  useFederationNodeHealth,
} from "./queries/useFederationHealth";
import { severityToColor } from "@/components/federation/federationHealthColors";

/**
 * The route nav target for the top-bar SystemHealth icon. Consumers apply it directly
 * via `navigate(target)`. #1935 promoted the federation view from an in-drawer
 * `?drawer=settings&section=federation` overlay to its own routes, so this is now a path
 * target (FED → the overview; per-node → the nested detail route) instead of a
 * search-param object.
 */
export type SystemHealthTarget =
  | { to: "/settings/federation" }
  | { to: "/settings/federation/$nodeId"; params: { nodeId: string } };

export type SystemHealthDisplay = {
  color: string;
  label: string;
  target: SystemHealthTarget;
};

/**
 * Resolve the top-bar System Health icon's color, 3-char label, and click
 * target from the user's `systemHealthDisplayTarget` preference. Issue #1040
 * OWNS this hook; #1043 consumes it to bind the icon (BrandedFrame / App.tsx).
 *
 * LOCKED HOOK CONTRACT (coordinated with #1043) — returns `{ color, label, target }`:
 * - FED mode (`pref === "FED"`): color = aggregate worst-case severity, with a
 *   D5 LOCAL-health fallback when the aggregate is unavailable (503 steady-state
 *   on standalone/spoke deployments, or any error); gray `unknown` only when
 *   local health is ALSO unavailable.
 * - Per-node mode: color = that node's status.
 * - `label` = "FED", else the node label's first 3 chars AS-IS (no uppercasing).
 * - `target` = a route nav target: `{ to: "/settings/federation" }` (FED) or
 *   `{ to: "/settings/federation/$nodeId", params: { nodeId } }` (per-node) — #1935.
 *
 * Never throws and never blocks render on health-data availability.
 */
export function useSystemHealthDisplayTarget(
  api: ApiClient | null
): SystemHealthDisplay {
  const { prefs } = useAdminPreferences();
  const pref = prefs.systemHealthDisplayTarget;
  const isFed = pref === "FED";

  const { localNode, remoteNodes } = useFederatedSessions(api);

  // Rules of Hooks: call all three unconditionally. The per-node query is
  // `enabled` only when not in FED mode; the aggregate + local-health hooks
  // run regardless (cheap, shared cache).
  const { aggregate } = useFederationHealthAggregate(api);
  const { node } = useFederationNodeHealth(api, isFed ? null : pref);
  const { status: localHealthStatus } = useHealthStatus(api);

  let color: string;
  if (isFed) {
    if (aggregate) {
      color = severityToColor(aggregate.worstCaseSeverity);
    } else {
      // D5 fallback — aggregate unavailable: derive from LOCAL health.
      // localHealthStatus is "unknown" (gray) only when local health is also
      // unavailable, preserving today's standalone behavior.
      color = getStatusColor(localHealthStatus);
    }
  } else {
    color = node?.status
      ? severityToColor(node.status)
      : getStatusColor("unknown");
  }

  // Resolve the per-node label from the known node list (local + remotes).
  const candidates = [...(localNode ? [localNode] : []), ...remoteNodes];
  const matched = candidates.find(n => n.nodeId === pref);
  const label = isFed ? "FED" : (matched?.nodeLabel ?? pref).slice(0, 3);

  const target: SystemHealthTarget = isFed
    ? { to: "/settings/federation" }
    : { to: "/settings/federation/$nodeId", params: { nodeId: pref } };

  return { color, label, target };
}
