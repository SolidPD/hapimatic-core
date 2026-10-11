// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import type { AgentFlavor, HarnessManifest, TriState } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { SubheadingBar } from "@/components/SessionList/SubheadingBar";
import { useHarnessManifests } from "@/hooks/queries/useHarnessManifests";
import { getStorageKey } from "@/lib/storage-keys";
import type { AgentType } from "./types";

/**
 * Create-page capability disclosure (issue #3121, epic #3117 Sub-Issue E;
 * layout replaced by #3314 — landed with epic #3285 round 11, 2026-09-07).
 *
 * Renders the selected harness's capability axes — derived from the live #3118
 * manifest (R1, no hardcoded data) — under a full-width, collapsible
 * **"Capabilities"** subheading (the session list's `SubheadingBar`, so it has
 * exactly the managed-peers subheading's height and chevron-right anatomy).
 * Collapsed, the bar shows the `N native · N emulated · N absent` summary;
 * expanded, the #3314-pinned **M1 spec grid** — one fixed label → state slot
 * per axis, two columns from `sm`, one column at phone width. The collapsed /
 * expanded state persists across Create pages (port-scoped localStorage).
 * The delta-vs-Claude warning block (R2) renders BELOW the bar whenever a
 * trust-relevant axis degrades — visible in both states, it is the part that
 * must never be hidden.
 *
 * The pure predicates (`computeTrustDelta`, `capabilityChips`,
 * `capabilitySummary`) are exported for unit testing; the component only wires
 * them to the manifest hook and the JSX.
 */

// ---------------------------------------------------------------------------
// Pinned KD4 warning copy. Epic ruling A1: server-side workflow gates bind ALL
// clients and are NEVER shown as degraded — the hooks warnings instead carry the
// FIXED reassurance that gates are still enforced server-side. Do NOT phrase any
// warning as "gates degraded".
// ---------------------------------------------------------------------------
export const HOOKS_PLUGIN_SHIM_WARNING =
  "Hooks emulated via plugin shim — hook-driven checks degraded on this harness. " +
  "Workflow gates are enforced server-side and still bind.";

export const HOOKS_NONE_WARNING =
  "No client-side hooks on this harness. Workflow gates are enforced " +
  "server-side only (they bind all clients).";

export const SUBAGENTS_ABSENT_WARNING =
  "No subagents on this harness — parallel subagent delegation is unavailable " +
  "(Claude runs subagents natively).";

export const SUBAGENTS_EMULATED_WARNING =
  "Subagents are emulated on this harness — parallel subagent delegation may be " +
  "degraded (Claude runs them natively).";

export type TrustDeltaAxis = "hooks" | "subagents";

export interface TrustDeltaWarning {
  axis: TrustDeltaAxis;
  message: string;
}

/**
 * Pure delta-vs-Claude predicate over the REAL #3118 manifest axes (KD4).
 *
 * There is NO `gates` axis in the schema, and this helper must never emit one:
 * server-side gates bind all clients (epic ruling A1). What varies per harness
 * is the CLIENT-side hook tier (`hooks.mode`) and subagent support — those are
 * what the warnings describe.
 *
 * - hooks: keyed on the selected harness's `hooks.mode` per KD4's pinned table
 *   (Claude is `native-taxonomy`, so a `native-taxonomy` selection = no delta).
 * - subagents: a genuine comparison — warn only when Claude runs them natively
 *   but the selected harness degrades (`absent`/`emulated`).
 */
export function computeTrustDelta(
  selected: HarnessManifest,
  claude: HarnessManifest
): TrustDeltaWarning[] {
  const warnings: TrustDeltaWarning[] = [];

  if (selected.hooks.mode === "plugin-shim") {
    warnings.push({ axis: "hooks", message: HOOKS_PLUGIN_SHIM_WARNING });
  } else if (selected.hooks.mode === "none") {
    warnings.push({ axis: "hooks", message: HOOKS_NONE_WARNING });
  }

  if (claude.subagents === "native" && selected.subagents !== "native") {
    warnings.push({
      axis: "subagents",
      message:
        selected.subagents === "absent"
          ? SUBAGENTS_ABSENT_WARNING
          : SUBAGENTS_EMULATED_WARNING,
    });
  }

  return warnings;
}

export interface CapabilityChip {
  label: string;
  state: TriState;
}

/** `hooks.mode` → tri-state (native-taxonomy=native, plugin-shim=emulated, none=absent). */
function hooksTriState(mode: HarnessManifest["hooks"]["mode"]): TriState {
  if (mode === "native-taxonomy") return "native";
  if (mode === "plugin-shim") return "emulated";
  return "absent";
}

/** `skills.mode` → tri-state (native-dir=native, injected=emulated, none=absent). */
function skillsTriState(mode: HarnessManifest["skills"]["mode"]): TriState {
  if (mode === "native-dir") return "native";
  if (mode === "injected") return "emulated";
  return "absent";
}

/**
 * Derive the disclosure rows from a manifest — the tri-state/mode capability
 * axes an operator weighs when choosing a harness. `mcp` is always `native` for
 * a stock manifest (every one carries an MCP config format). `acp` is omitted:
 * its inverse delta (non-Claude harnesses expose an ACP server while Claude does
 * not) would muddy a "delta-vs-Claude" disclosure.
 */
export function capabilityChips(m: HarnessManifest): CapabilityChip[] {
  return [
    { label: "Hooks", state: hooksTriState(m.hooks.mode) },
    { label: "Subagents", state: m.subagents },
    { label: "Skills", state: skillsTriState(m.skills.mode) },
    { label: "MCP", state: "native" },
    { label: "Sandboxing", state: m.sandboxing },
    { label: "Session roles", state: m.sessionRoles },
    { label: "Output styles", state: m.outputStyles },
  ];
}

/** The collapsed-bar summary (#3314 R1): `N native · N emulated · N absent`. */
export function capabilitySummary(chips: CapabilityChip[]): string {
  const count = (state: TriState) =>
    chips.filter(c => c.state === state).length;
  return `${count("native")} native · ${count("emulated")} emulated · ${count("absent")} absent`;
}

const STATE_TEXT_CLASS: Record<TriState, string> = {
  native: "text-[var(--app-badge-success-text)]",
  emulated: "text-[var(--app-badge-warning-text)]",
  absent: "text-[var(--app-badge-error-text)]",
};

/** Persisted collapsed/expanded state — port-scoped, survives every Create page. */
const COLLAPSED_STORAGE_KEY = "hapi:create:capabilities-collapsed:v1";

function readCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(getStorageKey(COLLAPSED_STORAGE_KEY));
    // Default COLLAPSED — the summary count carries the gist; the grid is a tap away.
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(
      getStorageKey(COLLAPSED_STORAGE_KEY),
      collapsed ? "1" : "0"
    );
  } catch {
    // Storage unavailable (private mode / quota) — the state is in-memory only.
  }
}

function rowSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function CapabilityChips(props: {
  agent: AgentType;
  api: ApiClient | null;
}) {
  const { data: manifests } = useHarnessManifests(props.api);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  // AgentType and AgentFlavor are the identical stock-4 union.
  const selected = manifests?.[props.agent as AgentFlavor];
  const claude = manifests?.claude;

  // Loading / empty manifest → render nothing (graceful; R2 empty fallback).
  if (!selected) return null;

  const chips = capabilityChips(selected);
  const warnings = claude ? computeTrustDelta(selected, claude) : [];

  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="capability-chips">
      <SubheadingBar
        collapsed={collapsed}
        onToggle={() => setCollapsed(c => !c)}
        label="Capabilities"
        count={capabilitySummary(chips)}
        countClassName="opacity-80"
        className="rounded-md bg-[var(--app-subtle-bg)] text-[var(--app-hint)] hover:bg-[var(--app-hover)]"
        aria-controls="create-capabilities-grid"
        data-testid="capabilities-subheading"
      />
      {!collapsed ? (
        <dl
          id="create-capabilities-grid"
          data-testid="capabilities-grid"
          className="grid grid-cols-1 gap-x-6 px-2 sm:grid-cols-2"
        >
          {chips.map(chip => (
            <div
              key={chip.label}
              data-testid={`capability-row-${rowSlug(chip.label)}`}
              data-state={chip.state}
              className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] py-1"
            >
              <dt className="text-xs text-[var(--app-hint)]">{chip.label}</dt>
              <dd
                className={`text-xs font-medium ${STATE_TEXT_CLASS[chip.state]}`}
              >
                {chip.state}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {warnings.length > 0 ? (
        <div
          className="rounded-md border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] px-3 py-2 text-xs text-[var(--app-badge-warning-text)]"
          role="status"
          data-testid="capability-delta-warning"
        >
          <div className="mb-1 font-semibold">Capability delta vs Claude</div>
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map(w => (
              <li key={w.axis}>{w.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
