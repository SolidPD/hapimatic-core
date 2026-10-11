// SPDX-License-Identifier: AGPL-3.0-only
import { RefreshCw } from "lucide-react";
import type { FederationNodeStatus } from "@hapi/protocol";
import type { DaemonCapSource } from "@hapi/protocol/schemas";
import { PCB_TOOLCHAIN_TAG } from "@hapi/protocol";
import type { Machine } from "@/types/api";
import { Button } from "@/components/ui/button";
import { FormField } from "./FormField";
import { UiSelect } from "./controls";

export type RemoteNode = {
  nodeId: string;
  nodeLabel: string;
  status: FederationNodeStatus;
  sessionCount?: number;
  connectedCount?: number;
  disconnectedCount?: number;
  platform?: string;
  /** Capabilities advertised by this node — agent:<name> (agent:claude,
   *  agent:codex, …) and, issue #3458, tool:<name> (e.g. tool:kicad-cli) for
   *  hardware toolchains. An absent tool:* tag means *unknown*. */
  capabilities?: string[];
  /** #2533: node's home dir — seeds the Create page's Directory field for a
   *  remote target. Undefined for stale peers. */
  homeDir?: string;
  // #1805: per-machine spawn capacity for the slot meter (R3). Undefined for
  // stale peers / unknown capacity → the meter renders "—".
  effectiveCount?: number;
  maxConcurrent?: number;
  // #4417: warn-at count + resolver source for the remote Create-page notice.
  // Undefined for a pre-#4417 peer → no warning / source "remote".
  recommendedConcurrent?: number;
  capSource?: DaemonCapSource;
};

/**
 * Value prefixes used to discriminate between local machines and remote nodes
 * in the `<select>` element. The consumer parses these back out via
 * `parseSpawnTarget()`.
 */
export const MACHINE_PREFIX = "machine:";
export const NODE_PREFIX = "node:";

export type SpawnTarget =
  | { kind: "local"; machineId: string }
  | { kind: "remote"; nodeId: string };

export function parseSpawnTarget(value: string): SpawnTarget | null {
  if (value.startsWith(MACHINE_PREFIX)) {
    return { kind: "local", machineId: value.slice(MACHINE_PREFIX.length) };
  }
  if (value.startsWith(NODE_PREFIX)) {
    return { kind: "remote", nodeId: value.slice(NODE_PREFIX.length) };
  }
  // Legacy: bare value is a local machineId (backwards compat during transition)
  if (value) {
    return { kind: "local", machineId: value };
  }
  return null;
}

export function getMachineTitle(machine: Machine): string {
  if (machine.metadata?.displayName) return machine.metadata.displayName;
  if (machine.metadata?.host) return machine.metadata.host;
  return machine.id.slice(0, 8);
}

function getNodeStatusSuffix(status: FederationNodeStatus): string {
  if (status === "offline") return " (offline)";
  if (status === "degraded") return " (degraded)";
  return "";
}

/**
 * Issue #3458: per-option hardware-toolchain marker. Returns a short text suffix
 * (` · PCB`) when the node/machine advertises the PCB toolchain (`tool:kicad-cli`,
 * via `PCB_TOOLCHAIN_TAG` — never a bare `"tool:` literal), else "". Computed
 * INSIDE this component (not via a prop) because a native <select> <option> is
 * text-only — a Badge element cannot render there (expert ruling A-D10) — and a
 * per-node marker that helps you CHOOSE a node must be visible per option, before
 * selection. Absent/empty caps → "" (R4).
 */
function getToolchainSuffix(caps?: readonly string[]): string {
  return caps?.includes(PCB_TOOLCHAIN_TAG) ? " · PCB" : "";
}

function formatInlineCounts(
  connected: number | undefined,
  disconnected: number | undefined
): string {
  const parts: string[] = [];
  if (connected !== undefined) {
    parts.push(`${connected} connected`);
  }
  if (disconnected !== undefined) {
    parts.push(`${disconnected} disconnected`);
  }
  return parts.length > 0 ? `: ${parts.join(", ")}` : "";
}

export function MachineSelector(props: {
  machines: Machine[];
  remoteNodes?: RemoteNode[];
  machineId: string | null;
  isLoading?: boolean;
  isDisabled: boolean;
  localSessionCount?: number;
  localConnectedCount?: number;
  localDisconnectedCount?: number;
  onChange: (value: string) => void;
  /**
   * #3456: presentational refresh affordance for the Federation Node field.
   * The parent (`NewSession/index.tsx`) owns the `usePollFederation` mutation +
   * toast and passes `{ onClick, isPending }`; `MachineSelector` stays hook-free
   * (no `api`, no `useQueryClient`) so its provider-less tests keep working.
   */
  federationRefresh?: { onClick: () => void; isPending: boolean };
}) {
  const hasRemoteNodes = (props.remoteNodes?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-1 px-3 py-1.5">
      <FormField
        label="Federation Node"
        tooltip="Which machine in your federation runs this session. The whole session — its files, git operations, and the agent process — lives on the selected node. The counts show how many sessions each node is already running; pick a different node to spread work across machines."
        bookmarkId="federationNode"
        labelAction={
          hasRemoteNodes && props.federationRefresh ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={props.federationRefresh.onClick}
              disabled={props.federationRefresh.isPending}
              aria-label="Refresh federation"
              title="Re-poll the federation now"
              data-testid="federation-refresh"
              className="h-5 w-5 text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] disabled:opacity-40"
            >
              <RefreshCw
                className={
                  "h-3 w-3 " +
                  (props.federationRefresh.isPending ? "animate-spin" : "")
                }
                aria-hidden="true"
              />
            </Button>
          ) : undefined
        }
      >
        <UiSelect
          value={props.machineId ?? ""}
          onChange={e => props.onChange(e.target.value)}
          disabled={props.isDisabled}
        >
          {props.isLoading && <option value="">Loading machines...</option>}
          {!props.isLoading &&
            props.machines.length === 0 &&
            !hasRemoteNodes && <option value="">No machines available</option>}

          {/* Local machines — use optgroup when remote nodes exist */}
          {hasRemoteNodes ? (
            <optgroup label="Local">
              {props.machines.map(m => (
                <option key={m.id} value={`${MACHINE_PREFIX}${m.id}`}>
                  {getMachineTitle(m)}
                  {getToolchainSuffix(m.metadata?.capabilities)}
                  {formatInlineCounts(
                    props.localConnectedCount,
                    props.localDisconnectedCount
                  )}
                </option>
              ))}
            </optgroup>
          ) : (
            props.machines.map(m => (
              <option key={m.id} value={`${MACHINE_PREFIX}${m.id}`}>
                {getMachineTitle(m)}
                {getToolchainSuffix(m.metadata?.capabilities)}
                {formatInlineCounts(
                  props.localConnectedCount,
                  props.localDisconnectedCount
                )}
              </option>
            ))
          )}

          {/* Remote nodes — standardized formatting matching local machines */}
          {hasRemoteNodes && (
            <optgroup label="Remote">
              {props.remoteNodes!.map(n => (
                <option
                  key={n.nodeId}
                  value={`${NODE_PREFIX}${n.nodeId}`}
                  disabled={n.status === "offline"}
                >
                  {n.nodeId}
                  {getNodeStatusSuffix(n.status)}
                  {getToolchainSuffix(n.capabilities)}
                  {n.status !== "offline"
                    ? formatInlineCounts(n.connectedCount, n.disconnectedCount)
                    : ""}
                </option>
              ))}
            </optgroup>
          )}
        </UiSelect>
      </FormField>
    </div>
  );
}
