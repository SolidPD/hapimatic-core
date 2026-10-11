// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import {
  displayNodeLabel,
  FederationNodeHealthStatusSchema,
} from "@hapi/protocol";
import type {
  FederationNodeHealth,
  FederationNodeHealthStatus,
} from "@hapi/protocol";
import { Button } from "@/components/ui/button";
import { NodeHealthModal } from "@/components/NodeHealthModal";
import { useAppContext } from "@/lib/app-context";
import { getStorageKey } from "@/lib/storage-keys";
import { useFederationHealthNodes } from "@/hooks/queries/useFederationHealth";
import {
  severityToColor,
  severityToLabel,
} from "@/components/federation/federationHealthColors";

/**
 * NodeBadge — node origin indicator for federated sessions.
 * Renders for ALL sessions when federation is enabled (both local hub and remote).
 * Shows the node label with a persistent color and, per the Session-UI taxonomy
 * (#3287 R1 / E6 `.nodebadge .health`, epic #3285 correction pass 1), a small
 * **health dot overlaid INSIDE the badge's bottom-right corner** whose color is
 * the worst of connectivity (`nodeStatus`) and the server-computed resource
 * health (issue #3662): green = healthy, amber = degraded / draining, orange =
 * warning, red = critical, and a black dot with a thin white ring for a
 * CONNECTIVITY-offline node. Resource-health "offline" means "no fresh metrics
 * sample" (never sampled / fetch failed / aged out) and falls back to
 * connectivity coloring (D13 Option A) — only the connectivity axis paints the
 * dot black. The dot is ALWAYS present (a healthy node is
 * a positive signal, not the absence of one); it carries a bg-colored ring so
 * it reads over the badge's tinted background. E9 (operator round 11,
 * 2026-09-06): the dot is inset 2px from the corner rather than hanging half
 * outside it, so it never pokes past the badge's box.
 *
 * Tap (operator ruling, round 10, 2026-09-07): opens the **Node Health modal**
 * — the Settings → Federation per-node health page in the app's centered modal
 * — so the node's stats are one tap from any session. The badge used to be a
 * link to the node's native UI; that link now lives in the modal's footer.
 * Pointer events stop at the badge so a list row's select / long-press /
 * navigate never fires from a badge tap (the same isolation the bell uses).
 */

/**
 * Node identity color (issue #4538).
 *
 * TEN hues in the OPERATOR-DICTATED hand-out order — do not reorder or
 * "optimize":
 *   1 blue · 2 fuchsia · 3 lime · 4 cyan · 5 pink · 6 amber · 7 violet · 8 rose
 *   · 9 orange · 10 teal
 * The near-twin pairs (ΔE×100 measured on the browser-rendered 15 % bands:
 * teal~cyan 1.5, rose~pink 1.9, orange~amber 2.3) sit at slots 4/10, 5/8 and
 * 6/9, so they only co-occur once a mesh is that large.
 *
 * ASSIGNMENT (operator ruling Q-B): sort every known node id (plain code-unit
 * string sort — identical on every client) and give the k-th node palette
 * entry k, wrapping past ten. The known set is the federation health node list
 * the badge already polls (`/api/federation/health/nodes`): the aggregator
 * seeds it with the local node and keeps an offline peer until it is removed
 * from the federation config (`healthAggregator.ts` `sample()` reconciles
 * against the configured node states), so the colors are identical on every
 * node's UI and do NOT reshuffle when a node drops. There is no gray "local
 * hub" color any more — the local node takes its slot like any other. When the
 * list is unavailable (standalone / 503) or does not carry this node, fall back
 * to the djb2 hash of the id into the same ten entries.
 *
 * STATUS: a connectivity-OFFLINE node renders the retired hub gray — chip AND
 * the project-header band — so it reads as "grayed out" next to live nodes;
 * DEGRADED keeps the node color and signals only through the health dot. The
 * former red / yellow chip recolors are gone.
 *
 * Tailwind needs the class strings literal (JIT scans source), so each entry
 * spells its classes out; the band color — a CSS value for an inline style,
 * not a class — is derived from the hue key. Epic #3285 round 14: the 15 %
 * tints mix against `--chip-base` so the chip is OPAQUE inside the session list
 * and a tinted row (managed-peer gold, scheduled blue) never bleeds through it.
 */
export const NODE_PALETTE = [
  {
    key: "blue",
    bg: "bg-[color-mix(in_srgb,var(--color-blue-500)_15%,var(--chip-base))]",
    text: "text-blue-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-blue-400)_45%,transparent)]",
  },
  {
    key: "fuchsia",
    bg: "bg-[color-mix(in_srgb,var(--color-fuchsia-500)_15%,var(--chip-base))]",
    text: "text-fuchsia-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-fuchsia-400)_45%,transparent)]",
  },
  {
    key: "lime",
    bg: "bg-[color-mix(in_srgb,var(--color-lime-500)_15%,var(--chip-base))]",
    text: "text-lime-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-lime-400)_45%,transparent)]",
  },
  {
    key: "cyan",
    bg: "bg-[color-mix(in_srgb,var(--color-cyan-500)_15%,var(--chip-base))]",
    text: "text-cyan-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-cyan-400)_45%,transparent)]",
  },
  {
    key: "pink",
    bg: "bg-[color-mix(in_srgb,var(--color-pink-500)_15%,var(--chip-base))]",
    text: "text-pink-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-pink-400)_45%,transparent)]",
  },
  {
    key: "amber",
    bg: "bg-[color-mix(in_srgb,var(--color-amber-500)_15%,var(--chip-base))]",
    text: "text-amber-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-amber-400)_45%,transparent)]",
  },
  {
    key: "violet",
    bg: "bg-[color-mix(in_srgb,var(--color-violet-500)_15%,var(--chip-base))]",
    text: "text-violet-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-violet-400)_45%,transparent)]",
  },
  {
    key: "rose",
    bg: "bg-[color-mix(in_srgb,var(--color-rose-500)_15%,var(--chip-base))]",
    text: "text-rose-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-rose-400)_45%,transparent)]",
  },
  {
    key: "orange",
    bg: "bg-[color-mix(in_srgb,var(--color-orange-500)_15%,var(--chip-base))]",
    text: "text-orange-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-orange-400)_45%,transparent)]",
  },
  {
    key: "teal",
    bg: "bg-[color-mix(in_srgb,var(--color-teal-500)_15%,var(--chip-base))]",
    text: "text-teal-400",
    ring: "ring-1 ring-inset ring-[color-mix(in_srgb,var(--color-teal-400)_45%,transparent)]",
  },
] as const;

export type NodeHue = (typeof NODE_PALETTE)[number]["key"];

/** The resolved identity tone — the chip's classes plus the same fill as a CSS
 *  value, so the project header's row-2 band paints from ONE source (#4538 R3).
 *  `band` is null while the node list is not yet known (`pending`): the header
 *  draws no band rather than a color that is about to change. */
export type NodeTone = {
  key: NodeHue | "offline" | "pending";
  bgClass: string;
  textClass: string;
  ringClass: string;
  band: string | null;
};

// The retired local-hub gray, now the OFFLINE tone: 8 % of the foreground white
// over `--chip-base`, written INLINE so the mix resolves on the element itself
// wherever the chip or band renders. (Via a token it only resolves against the
// opaque base where the token is re-declared — `.chip-scope`, #4553; the band
// over the purple header must never fall back to a translucent fill, which
// read as light indigo there instead of gray.)
const NEUTRAL_FILL = "color-mix(in srgb, var(--app-fg) 8%, var(--chip-base))";
const OFFLINE_TONE: NodeTone = {
  key: "offline",
  bgClass: "bg-[color-mix(in_srgb,var(--app-fg)_8%,var(--chip-base))]",
  textClass: "text-[var(--app-muted)]",
  ringClass:
    "ring-1 ring-inset ring-[color-mix(in_srgb,var(--app-muted)_45%,transparent)]",
  band: NEUTRAL_FILL,
};

// Node list not known yet (first-ever load, before the health poll answers and
// with no remembered list): a neutral chip and NO band, so nothing paints a hue
// that is about to change. Distinct from offline by its health dot (offline is
// black) and by having no ring.
const PENDING_TONE: NodeTone = {
  key: "pending",
  bgClass: OFFLINE_TONE.bgClass,
  textClass: OFFLINE_TONE.textClass,
  ringClass: "",
  band: null,
};

// Last known node id list, per instance port. Remembered so a reload colors
// every chip from the right rank immediately instead of flashing the hash
// fallback until the health poll answers (#4538 review finding).
const KNOWN_NODE_IDS_KEY = "hapi:knownNodeIds:v1";

function readRememberedNodeIds(): string[] | null {
  try {
    const raw = localStorage.getItem(getStorageKey(KNOWN_NODE_IDS_KEY));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(id => typeof id === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * The node ids to rank against: the live health list once it has answered
 * (remembered for the next load), else the remembered list, else — still
 * loading with nothing remembered — null ("unknown": pending tone). A settled
 * query with no usable list (503 / standalone) yields [] → the hash fallback.
 */
function useKnownNodeIds(health: {
  nodes: FederationNodeHealth[];
  isLoading: boolean;
  isError: boolean;
}): readonly string[] | null {
  const { nodes, isLoading, isError } = health;
  const liveKey =
    !isLoading && !isError && nodes.length > 0
      ? JSON.stringify(nodes.map(n => n.nodeId).sort())
      : null;
  useEffect(() => {
    if (!liveKey) return;
    try {
      const key = getStorageKey(KNOWN_NODE_IDS_KEY);
      if (localStorage.getItem(key) !== liveKey) {
        localStorage.setItem(key, liveKey);
      }
    } catch {
      // Storage unavailable / full — colors still resolve from the live list.
    }
  }, [liveKey]);
  return useMemo(() => {
    if (liveKey) return JSON.parse(liveKey) as string[];
    return readRememberedNodeIds() ?? (isLoading ? null : []);
  }, [liveKey, isLoading]);
}

export function hashNodeId(id: string): number {
  let hash = 5381;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 33) ^ id.charCodeAt(i);
  }
  return Math.abs(hash);
}

/**
 * Palette slot for `nodeId`: its rank in the sorted known-node set (mod 10), or
 * the djb2 fallback when the set is empty / does not carry it.
 */
export function nodePaletteIndex(
  nodeId: string,
  knownNodeIds: readonly string[]
): number {
  // Default `.sort()` = UTF-16 code-unit order: deterministic and locale-free,
  // so every client ranks the same ids the same way.
  const sorted = Array.from(new Set(knownNodeIds)).sort();
  const rank = sorted.indexOf(nodeId);
  if (rank >= 0) return rank % NODE_PALETTE.length;
  return hashNodeId(nodeId) % NODE_PALETTE.length;
}

/**
 * `knownNodeIds` null = the node list is not known yet → the pending tone;
 * [] or a list without this id → the hash fallback.
 */
export function resolveNodeTone(
  nodeId: string,
  nodeStatus: "online" | "degraded" | "offline" | undefined,
  knownNodeIds: readonly string[] | null
): NodeTone {
  if (nodeStatus === "offline") return OFFLINE_TONE;
  if (knownNodeIds === null) return PENDING_TONE;
  const hue = NODE_PALETTE[nodePaletteIndex(nodeId, knownNodeIds)];
  return {
    key: hue.key,
    bgClass: hue.bg,
    textClass: hue.text,
    ringClass: hue.ring,
    band: `color-mix(in srgb, var(--color-${hue.key}-500) 15%, var(--chip-base))`,
  };
}

/**
 * The node tone for a surface that is not a badge (the project header's row-2
 * band). Shares the badge's deduped health poll; pass `undefined` to stay idle
 * (returns null) — e.g. a single-node list, where no band is drawn.
 */
export function useNodeTone(
  nodeId: string | undefined,
  nodeStatus: "online" | "degraded" | "offline" | undefined
): NodeTone | null {
  const { api } = useAppContext();
  const health = useFederationHealthNodes(nodeId ? api : null);
  const knownNodeIds = useKnownNodeIds(health);
  if (!nodeId) return null;
  return resolveNodeTone(nodeId, nodeStatus, knownNodeIds);
}

export function NodeBadge({
  nodeId,
  nodeLabel,
  nodeUrl,
  nodeStatus,
  fillCell = false,
}: {
  nodeId?: string;
  nodeLabel?: string;
  nodeUrl?: string;
  nodeStatus?: "online" | "degraded" | "offline";
  /**
   * E8/E9: render as a fixed CELL — the badge fills its parent's width (the
   * Row-1 right block, `NODE_BADGE_CELL_PX`) with the label centered — instead
   * of shrink-wrapping the label. The Session Basic Info Bar surfaces set this.
   * WIDTH is the only thing this changes: the chip's padding, type, color and
   * health dot are identical in both forms (the project header shrink-wraps).
   */
  fillCell?: boolean;
}): React.ReactElement | null {
  // Hook before the early return (rules-of-hooks); the modal mounts only while
  // open, so a closed badge in a long list carries no data/mutation hooks.
  const [healthOpen, setHealthOpen] = useState(false);
  // Resource-health poll (issue #3662): one ~30s TanStack-Query, deduped across
  // ALL badges (not per-badge). Pass a null api when there is no nodeId so a
  // standalone/spoke deployment (every badge nodeId-less) never polls a 503 on
  // top of the aggregate already polled elsewhere (enabled: Boolean(api)). These
  // hooks sit ABOVE the `!nodeId` early return for rules-of-hooks.
  const { api } = useAppContext();
  const health = useFederationHealthNodes(nodeId ? api : null);
  const { nodes, isError } = health;
  // #4538: the ids to rank against (live list, else the remembered one).
  const knownNodeIds = useKnownNodeIds(health);
  if (!nodeId) return null;

  // System-wide casing rule (epic #3285 round 11): local machines UPPER CASE,
  // cloud VMs lower case. The server normalizes labels at their entry points;
  // this is the client-side safety net for a stale peer's label.
  const casedLabel = displayNodeLabel(nodeLabel ?? nodeId, { url: nodeUrl });
  // 6 chars max: the E8 cell holds "5 characters, centered"; our 51px cell with
  // its 4px + 10px (dot pocket) padding fits six 6px mono glyphs.
  const display = casedLabel.slice(0, 6);
  const isOffline = nodeStatus === "offline";
  const isDegraded = nodeStatus === "degraded";

  // Identity tone (#4538): the sorted-ID palette slot over the known node list;
  // gray when connectivity-offline; unchanged when degraded (the dot signals it);
  // neutral while the list is not known yet.
  const tone = resolveNodeTone(nodeId, nodeStatus, knownNodeIds);

  // Health dot (E6 `.health`, issue #3662): 5-state severity from the worst of
  // connectivity (`nodeStatus`) and the server-computed resource-health `status`.
  // Resolved as exactly one of three branches, IN ORDER (D13 Option A):
  //   1. connectivity offline  → black fill + thin white ring (the ONLY axis that
  //      asserts unreachability; the registry trips offline after ~3 failed polls,
  //      always before the aggregator's 60-90s grace, so a dead node reaches black
  //      on this clock first);
  //   2. resource health unavailable (503/standalone/spoke, no entry for this
  //      nodeId, or online:false = "no fresh sample") → fall back to today's
  //      connectivity-only coloring (R5 — no regression; resource-`offline` never
  //      paints a reachable node black);
  //   3. health available (online === true ⇔ status in healthy..critical) →
  //      worst-of(connectivity, resource) via `severityToColor` (a
  //      `var(--status-sev-*)` string applied through `style`, the #1037 parity
  //      lock-point — never a Tailwind class, never a hex).
  const nodeHealth = nodes.find(n => n.nodeId === nodeId);
  const resourceUnavailable =
    isError || !nodeHealth || nodeHealth.online === false;
  const severityRank = (s: FederationNodeHealthStatus): number =>
    FederationNodeHealthStatusSchema.options.indexOf(s);

  let healthLabel: string;
  let healthColor: string; // a `bg-*` class; "" when the fill rides `healthStyle`
  let healthRing: string; // ring color class (bg-tinted normally; white if offline)
  let healthStyle: React.CSSProperties | undefined;

  if (isOffline) {
    healthLabel = "offline";
    healthColor = "bg-black";
    healthRing = "border-[var(--app-fg)]";
    healthStyle = undefined;
  } else if (resourceUnavailable) {
    // Preserve today's connectivity-only dot exactly (R5).
    healthLabel = isDegraded ? "degraded" : "online";
    healthColor = isDegraded
      ? "bg-[var(--app-badge-warning-text)]"
      : "bg-[var(--app-badge-success-text)]";
    healthRing = "border-[var(--app-bg)]";
    healthStyle = undefined;
  } else {
    // `nodeHealth` is defined here (resourceUnavailable already excluded
    // undefined / offline). Connectivity `degraded` = draining (not resource
    // pressure); mapping it to severity `degraded` preserves today's amber.
    const health = nodeHealth!;
    const connectivitySeverity: FederationNodeHealthStatus = isDegraded
      ? "degraded"
      : "healthy";
    const worst =
      severityRank(health.status) > severityRank(connectivitySeverity)
        ? health.status
        : connectivitySeverity;
    healthLabel = severityToLabel(worst).toLowerCase();
    healthColor = "";
    healthRing = "border-[var(--app-bg)]";
    healthStyle = { backgroundColor: severityToColor(worst) };
  }

  const title = `${casedLabel} (${healthLabel}) — node health`;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const badge = (
    <span
      className={`relative inline-flex items-center justify-center pl-1 pr-2.5 py-[2.5px] text-[length:var(--text-caption-xs)] font-mono font-bold tracking-wide leading-tight rounded-md ${tone.bgClass} ${tone.textClass} ${tone.ringClass} whitespace-nowrap ${
        fillCell ? "w-full" : ""
      }`} /* design-tokens-allow: py-[2.5px] is the E9 `.nodebadge` padding (mockup-pinned); no --space token at 2.5px */
      data-testid="node-badge"
      data-tone={tone.key}
    >
      {/* pr-2.5 (10px): the inset health dot occupies the 2–9px band from the
          right edge, so the label needs ≥9px of right padding to stay clear of
          it — 10px leaves a 1px gutter (E9 inset, 2026-09-06). */}
      {display}
      <span
        aria-hidden="true"
        data-testid="node-health-dot"
        data-health={healthLabel}
        className={`absolute bottom-0.5 right-0.5 h-[7px] w-[7px] rounded-full border-[1.5px] ${healthRing} ${healthColor}`} /* design-tokens-allow: 7px health dot + 1.5px ring are the E6 `.health` overlay dimensions (mockup-pinned); no icon-size token at 7px; the connectivity-offline ring uses border-[var(--app-fg)] (thin white) for legibility on the dark badge */
        style={healthStyle}
      />
    </span>
  );

  return (
    <>
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        title={title}
        aria-label={title}
        data-testid="node-badge-trigger"
        className={`inline-flex font-normal hover:opacity-80 ${fillCell ? "w-full" : ""}`}
        onClick={e => {
          e.stopPropagation();
          e.preventDefault();
          setHealthOpen(true);
        }}
        // The DOWN and UP events too: SessionItem's row navigation runs on
        // useLongPress's onMouseUp/onTouchEnd, and its click detection fires on a
        // bare up-event even when the down was stopped (see the bell, round-2 #87).
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
        onMouseUp={stop}
        onTouchEnd={stop}
        onPointerUp={stop}
      >
        {badge}
      </Button>
      {healthOpen && (
        <NodeHealthModal
          nodeId={nodeId}
          nodeLabel={nodeLabel}
          nodeUrl={nodeUrl}
          nodeStatus={nodeStatus}
          open={healthOpen}
          onOpenChange={setHealthOpen}
        />
      )}
    </>
  );
}
