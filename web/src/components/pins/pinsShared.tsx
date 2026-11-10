// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  GitBranch,
  Layers,
  LayoutDashboard,
  ListChecks,
  MessageSquareDot,
  Pin as PinGlyph,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import type { Pin } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { tokens } from "@/design/tokens";
import { ChevronIcon } from "@/components/icons";
import { BareButton, type BareButtonProps } from "@/components/ui/BareButton";
import {
  HoverTooltip,
  HoverTooltipButton,
  type HoverTooltipButtonProps,
} from "@/components/ui/tooltip";
import type { StagedVia } from "@/lib/pins/staging";

/**
 * #6449: what every Pins component shares — the per-kind, stakes, and risk
 * display values (mockup v6 :499-502), the "armed" tooltip wrappers, and the
 * session context the expanded pins read.
 */

export type PinKindMeta = { label: string; icon: LucideIcon; color: string };

const KINDS: Record<string, PinKindMeta> = {
  decision: {
    label: "Decision",
    icon: GitBranch,
    color: tokens.pinKind.decision,
  },
  steps: { label: "Steps", icon: ListChecks, color: tokens.pinKind.steps },
  variants: {
    label: "Variants",
    icon: Layers,
    color: tokens.pinKind.variants,
  },
  review: {
    label: "Review",
    icon: MessageSquareDot,
    color: tokens.pinKind.review,
  },
  dashboard: {
    label: "Dashboard",
    icon: LayoutDashboard,
    color: tokens.pinKind.dashboard,
  },
  detected: {
    label: "Detected",
    icon: ScanSearch,
    color: tokens.pinKind.detected,
  },
};

/** A kind this build does not know (a newer peer's) still gets a glyph. */
export function pinKindMeta(kind: string): PinKindMeta {
  return (
    KINDS[kind] ?? {
      label: kind || "Pin",
      icon: PinGlyph,
      color: tokens.view.pins,
    }
  );
}

export const STAKES_META: Record<string, { label: string; color: string }> = {
  reversible: { label: "Reversible", color: "var(--status-ok)" },
  costly: { label: "Costly to undo", color: "var(--status-warn)" },
  irreversible: { label: "Irreversible", color: "var(--status-hot)" },
};

export const RISK_META: Record<
  string,
  { label: string; level: number; color: string }
> = {
  low: { label: "Low", level: 1, color: "var(--status-ok)" },
  medium: { label: "Medium", level: 2, color: "var(--status-warn)" },
  high: { label: "High", level: 3, color: "var(--status-hot)" },
};

/** A row's answer-pill cell (mockup v6 :683-687): its size and its pill shape. */
export const PIN_PILL_STYLE: CSSProperties = {
  height: "20px",
  minWidth: "24px",
  fontSize: "10.5px",
};
export const PIN_PILL_CLASS =
  "inline-flex items-center justify-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 font-bold tabular-nums";

/**
 * Stops a click from reaching the row. On a touch screen a tooltip trigger is
 * a Radix Popover trigger whose click still bubbles, and React portals bubble
 * the bubble's own clicks through the React tree too (`ui/tooltip.tsx`), so
 * every indicator and the star sit inside one of these.
 */
export function stopRowToggle(event: MouseEvent): void {
  event.stopPropagation();
}

/**
 * An indicator with its tooltip. Until its row is armed (`useArmedRows`, near
 * the screen) it is a plain element carrying the same text as an
 * `aria-label`; once armed it becomes a `ui/tooltip.tsx` tooltip trigger for
 * good. Measured: seven tooltips per row on 100-500 rows cost 159-914 ms to
 * mount on the host (#6449 performance review).
 */
export function PinIndicator(props: {
  label: string;
  armed: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const element = (
    <span
      role="img"
      aria-label={props.label}
      className={props.className}
      style={props.style}
    >
      {props.children}
    </span>
  );
  return props.armed ? (
    <HoverTooltip content={props.label}>{element}</HoverTooltip>
  ) : (
    element
  );
}

/**
 * A button with its tooltip: `HoverTooltipButton` once armed, a `BareButton`
 * with the same `aria-label` before.
 */
export function PinTipButton({
  armed,
  tooltip,
  ...button
}: Omit<HoverTooltipButtonProps, "content"> & {
  armed: boolean;
  tooltip: string;
}) {
  if (armed) return <HoverTooltipButton content={tooltip} {...button} />;
  return <BareButton {...(button as BareButtonProps)} />;
}

const KIND_BOX: CSSProperties = {
  width: "18px",
  height: "18px",
  borderRadius: "5px",
};
const KIND_ICON: CSSProperties = { width: "11px", height: "11px" };

/** A row's kind glyph in its tinted box, in a click-stopping grid cell. */
export function PinKindBadge(props: { kind: string; armed: boolean }) {
  const kind = pinKindMeta(props.kind);
  const KindIcon = kind.icon;
  return (
    <span onClick={stopRowToggle} className="flex">
      <PinIndicator
        armed={props.armed}
        label={`Kind: ${kind.label}`}
        className="grid place-items-center"
        style={{
          ...KIND_BOX,
          color: kind.color,
          backgroundColor: `color-mix(in srgb, ${kind.color} 16%, transparent)`,
        }}
      >
        <KindIcon style={KIND_ICON} aria-hidden />
      </PinIndicator>
    </span>
  );
}

/** A row's details chevron: the session list's chevron box (SessionItem.tsx). */
export function PinDetailsToggle(props: {
  pinKey: string;
  expanded: boolean;
  armed: boolean;
  onToggle: () => void;
}) {
  const { expanded } = props;
  return (
    <PinTipButton
      armed={props.armed}
      type="button"
      tooltip={expanded ? "Hide details" : "Show details"}
      aria-label={expanded ? "Hide pin details" : "Show pin details"}
      aria-expanded={expanded}
      aria-controls={expanded ? `pin-detail-${props.pinKey}` : undefined}
      onClick={props.onToggle}
      className="flex w-[var(--icon-btn-size)] shrink-0 items-center justify-center self-stretch rounded-md bg-[var(--app-secondary-bg)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
    >
      <ChevronIcon className="h-3.5 w-3.5" collapsed={!expanded} />
    </PinTipButton>
  );
}

/** Everything an expanded pin needs from its session, without prop threading. */
export type PinsContextValue = {
  api: ApiClient | null;
  sessionId: string;
  /** Evidence is read through a session RPC, so it needs a running session. */
  sessionActive: boolean;
  markSeen: (pin: Pin) => void;
  /** Where an answer made here is made (#6450): the Pins tab or a chat card. */
  via: StagedVia;
  /**
   * #6452: the zone every Pins time renders in, already through
   * `resolvePinZone`: the owning node's Time Log zone, else the browser's.
   */
  timeZone: string;
};

export const PinsContext = createContext<PinsContextValue | null>(null);

export function usePinsContext(): PinsContextValue {
  const value = useContext(PinsContext);
  if (!value) throw new Error("usePinsContext outside <PinsContext>");
  return value;
}

/** The `message-highlight` keyframes' length (`useUserMessageNavigation.ts`). */
const HIGHLIGHT_DURATION_MS = 800;
const HIGHLIGHT_CLASS = "animate-message-highlight";

/** Restart the flash on a row (the `highlightMessage` pattern). */
export function flashRow(element: HTMLElement): void {
  element.classList.remove(HIGHLIGHT_CLASS);
  void element.offsetWidth; // a reflow, so re-adding the class restarts it
  element.classList.add(HIGHLIGHT_CLASS);
  window.setTimeout(
    () => element.classList.remove(HIGHLIGHT_CLASS),
    HIGHLIGHT_DURATION_MS
  );
}

/** One shared clock for every row's age label (R6), ticking each minute. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
