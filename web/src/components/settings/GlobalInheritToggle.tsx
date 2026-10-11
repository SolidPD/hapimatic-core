// SPDX-License-Identifier: AGPL-3.0-only
import { BareButton } from "@/components/ui/BareButton";

/**
 * Issue #2624 (Sub-Issue B) — the per-setting 🌐 inherit toggle.
 *
 * Presentational only: filled (accent background) = inheriting the
 * federation-global value; muted/grayscale = this node holds a local override.
 * No data fetching here — it is driven by `useFederationSettings` via props,
 * mirroring the bookmark toggle's filled/outline semantics
 * (`NewSession/bookmarkContext.tsx`).
 */
export function GlobalInheritToggle(props: {
  /** Human label of the setting this toggle governs (accessibility text). */
  settingLabel: string;
  inherit: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  /** Peer-node count for the "propagates to N peer nodes" hint (optional). */
  nodeCount?: number;
}) {
  const propagation =
    props.nodeCount && props.nodeCount > 0
      ? ` — writes propagate to ${props.nodeCount} peer node${
          props.nodeCount === 1 ? "" : "s"
        }`
      : "";
  const stateText = props.inherit
    ? `inheriting the federation-global value${propagation}`
    : "using a node-local value — writes stay on this node";
  const label = `${props.settingLabel}: ${stateText}. Toggle to ${
    props.inherit
      ? "use a node-local value"
      : "re-adopt the federation-global value"
  }.`;
  return (
    <BareButton
      type="button"
      role="switch"
      aria-checked={props.inherit}
      aria-label={label}
      title={label}
      disabled={props.disabled}
      onClick={() => props.onToggle(!props.inherit)}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors disabled:cursor-default disabled:opacity-40 ${
        props.inherit
          ? "bg-[var(--app-link)] text-[var(--app-button-text)]"
          : "bg-[var(--app-secondary-bg)] opacity-70 grayscale hover:bg-white/10"
      }`}
    >
      <span aria-hidden="true">🌐</span>
    </BareButton>
  );
}
