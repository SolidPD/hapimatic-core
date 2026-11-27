// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6918: derive a spawn's manager stamp, once, at the spawn moment, on
 * the node that holds the parent. The result is written set-once beside the
 * parent link (`setManagerStamp`); `undefined` means "no decision" (the sweep
 * then uses its own rule).
 *
 * Checks, in this order (the directive's Task 4):
 *   1. the node's `HAPI_MANAGER_STAMP` switch is off → no decision;
 *   2. a watermark successor (it sends a parent with NO relationship) → the
 *      predecessor's stamp with reason `successor`, only behind
 *      `HAPI_MANAGER_STAMP_SUCCESSOR`; else no decision. Before step 3, so the
 *      successor's pair is not discarded by the relationship check;
 *   3. not a `spawn` relationship, or no parent id → no decision;
 *   4. a pair forwarded by the sending node → that pair (never derived here);
 *   5. no local parent → no decision;
 *   6. the spawn was not made by its parent → `not-from-parent`, but with no
 *      caller header only when the parent's wrapper reports the agent-caller
 *      marker (R10: a PM on a pre-upgrade wrapper is never made unsweepable);
 *   7. the parent is a manager → the parent, `manager`;
 *   8. the parent carries a stamp and has no operator message → that stamp,
 *      `inherited` (a takeover never passes a stamp down, DB);
 *   9. else → null, `none`.
 */
import type { ManagerStampWrite } from "../store/sessions";

export type ManagerStampParent = {
  id: string;
  managerSessionId?: string | null;
  metadata?: unknown;
};

export type ManagerStampInput = {
  /** `HAPI_MANAGER_STAMP` is exactly "1" on this node. */
  enabled: boolean;
  /** `HAPI_MANAGER_STAMP_SUCCESSOR` is exactly "1" on this node (MD7). */
  successorEnabled: boolean;
  /** Set on a watermark successor spawn only: its predecessor. */
  successorOf?: { managerSessionId?: string | null } | null;
  relationship?: "branch" | "spawn";
  parentSessionId?: string;
  /** The parent session on this node, or null when it is not local. */
  parent?: ManagerStampParent | null;
  /** The request's caller header resolved to the parent session. */
  requestedByParent?: boolean;
  /** The request carried a caller header at all. */
  callerHeaderPresent?: boolean;
  /** A pair forwarded by the node that holds the parent (validated upstream). */
  forwarded?: ManagerStampWrite;
  isManager: (parent: ManagerStampParent) => boolean;
  parentHasOperatorMessage: (parent: ManagerStampParent) => boolean;
};

/** True when the wrapper of `parent` reported the agent-caller marker (R10). */
export function parentReportsAgentCallerMarker(
  parent: ManagerStampParent
): boolean {
  const metadata = parent.metadata;
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as { agentCallerMarker?: unknown }).agentCallerMarker === true
  );
}

export function deriveManagerStamp(
  input: ManagerStampInput
): ManagerStampWrite | undefined {
  if (input.enabled !== true) return undefined;
  if (input.successorOf) {
    if (input.successorEnabled !== true) return undefined;
    return {
      managerSessionId: input.successorOf.managerSessionId ?? null,
      reason: "successor",
    };
  }
  if (input.relationship !== "spawn" || !input.parentSessionId) {
    return undefined;
  }
  if (input.forwarded) return input.forwarded;
  const parent = input.parent;
  if (!parent) return undefined;
  if (input.requestedByParent !== true) {
    return input.callerHeaderPresent === true ||
      parentReportsAgentCallerMarker(parent)
      ? { managerSessionId: null, reason: "not-from-parent" }
      : undefined;
  }
  if (input.isManager(parent)) {
    return { managerSessionId: parent.id, reason: "manager" };
  }
  if (parent.managerSessionId && !input.parentHasOperatorMessage(parent)) {
    return { managerSessionId: parent.managerSessionId, reason: "inherited" };
  }
  return { managerSessionId: null, reason: "none" };
}

/**
 * Issue #6918 (R7, V15): the receiving node keeps a forwarded pair only when
 * its own `HAPI_MANAGER_STAMP` is on, the body links a spawn parent, and the
 * pair is consistent: `manager` names the parent itself, `inherited` names
 * some manager, and `none` / `not-from-parent` name none. A `successor` pair is
 * never forwarded (a successor is decided on its own node). Anything else is
 * dropped and the session stays undecided.
 */
export function acceptForwardedManagerStamp(input: {
  enabled: boolean;
  parentRelationship?: "branch" | "spawn";
  parentSessionId?: string;
  pair?: ManagerStampWrite;
}): ManagerStampWrite | undefined {
  const { pair } = input;
  if (!pair || input.enabled !== true) return undefined;
  if (input.parentRelationship !== "spawn" || !input.parentSessionId) {
    return undefined;
  }
  switch (pair.reason) {
    case "manager":
      return pair.managerSessionId === input.parentSessionId ? pair : undefined;
    case "inherited":
      return pair.managerSessionId ? pair : undefined;
    case "none":
    case "not-from-parent":
      return pair.managerSessionId === null ? pair : undefined;
    default:
      return undefined;
  }
}
