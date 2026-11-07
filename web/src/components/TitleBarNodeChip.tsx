// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { NodeBadge } from "@/components/NodeBadge";
import { useAppContext } from "@/lib/app-context";
import {
  federationHealthAvailable,
  useFederationNodesInfo,
} from "@/hooks/queries/useFederationHealthAvailable";
import { IPAD_WINDOW_CONTROLS_INSET_X } from "@/hooks/useIPadMultitasking";
import {
  computeChipPlacement,
  type ChipObstacle,
} from "@/lib/titleBarChipPlacement";

/**
 * TitleBarNodeChip — the UI host node's `NodeBadge` in the app title bar
 * (issue #4468, epic #4460 Sub-Issue H): it shows at all times which node's web
 * UI the user is in. The chip is the UI host; a session header's badge is that
 * session's node. The two may differ and look identical by design.
 *
 * Position (`computeChipPlacement`): the chip's center sits at half the measured
 * wordmark `<Link>`'s left edge, nudged right past the back arrow (and, while
 * iPad multitasking, the window-control zone — ruling H-1 A), collapsed to the
 * health dot when it would pass the wordmark's clearance gap, and not rendered
 * when even the dot would.
 *
 * Hover shows "You are using <node>'s web UI" through the badge's `title`; on
 * touch a 500ms long-press opens the same text in a small popover and swallows
 * the click that ends it. Capture phase is required because `NodeBadge` stops
 * propagation at its button. A plain tap opens the Node Health modal.
 *
 * Mount it only where an app context exists: `NodeBadge` calls `useAppContext`,
 * which throws on the pre-auth screens (`BrandedFrame` gates on `appCtx?.api`).
 */

/** Right edge of the iPadOS window-control zone (the 75px inset). */
const WINDOW_CONTROLS_RIGHT = Number.parseFloat(IPAD_WINDOW_CONTROLS_INSET_X);

const LONG_PRESS_MS = 500;

/** How often a failed nodes read is retried while the chip has no node. */
export const NODES_RETRY_MS = 30_000;

/**
 * A copy of `ui/tooltip.tsx` TapTooltipContent's surface classes and its
 * bottom-side motion classes. Those constants are private to that module, so
 * a change there does not reach this hint; update both together.
 */
const HINT_CLASS =
  "z-50 max-w-xs rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-xs text-[var(--app-fg)] shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2";

export function titleBarChipHint(nodeLabel: string): string {
  return `You are using ${nodeLabel}'s web UI`;
}

interface Placed {
  /** Left offset inside the header container. */
  left: number;
  collapsed: boolean;
  hidden: boolean;
}

function samePlacement(a: Placed | null, b: Placed | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.left === b.left &&
      a.collapsed === b.collapsed &&
      a.hidden === b.hidden)
  );
}

export interface TitleBarNodeChipProps {
  /** The header's inner container; the chip is positioned inside it. */
  containerRef: RefObject<HTMLElement | null>;
  /** The wordmark `<Link>` (its box is the mark's box, never the DEV badge). */
  wordmarkRef: RefObject<HTMLElement | null>;
  /** The back-arrow wrapper, when it renders. */
  backArrowRef: RefObject<HTMLElement | null>;
  hasBackArrow: boolean;
  isIPadMultitasking: boolean;
}

export function TitleBarNodeChip({
  containerRef,
  wordmarkRef,
  backArrowRef,
  hasBackArrow,
  isIPadMultitasking,
}: TitleBarNodeChipProps): ReactElement | null {
  const { api } = useAppContext();
  // The same query (and key) the federated session list reads: deduped.
  const { data, isError, refetch } = useFederationNodesInfo(api);
  const localNode = data?.localNode ?? null;
  const nodeLabel = localNode?.nodeLabel ?? "";
  // The effects below key on the node arriving as well as on its label, so the
  // first placement does not depend on the label changing from "".
  const hasNode = localNode !== null;
  // Nothing else refetches this key on a schedule, so a read that fails while
  // the hub restarts would leave the chip out until a reload. Retry while the
  // read is failing and there is no node to show; a success, or a cached node
  // (even a stale one), stops the timer.
  useEffect(() => {
    if (!isError || hasNode) return;
    const timer = window.setInterval(() => void refetch(), NODES_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [isError, hasNode, refetch]);
  // A node without a health aggregator (a server older than #6217 on a
  // standalone or spoke) answers 503 to the health poll (R6).
  const resourceHealth = federationHealthAvailable(data);

  const measurerRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placed | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const wordmark = wordmarkRef.current;
    const measurer = measurerRef.current;
    if (!container || !wordmark || !measurer) {
      setPlacement(null);
      return;
    }
    const wordmarkRect = wordmark.getBoundingClientRect();
    // Always the hidden FULL badge: the visible chip shrinks to the dot when it
    // collapses, and reading that width would un-collapse it on the next pass.
    const chipWidth = measurer.getBoundingClientRect().width;
    // A box with no width is not laid out yet (or jsdom without mocked rects).
    if (wordmarkRect.width <= 0 || chipWidth <= 0) {
      setPlacement(null);
      return;
    }
    const obstacles: ChipObstacle[] = [];
    const arrowRect = hasBackArrow
      ? backArrowRef.current?.getBoundingClientRect()
      : undefined;
    if (arrowRect && arrowRect.width > 0) {
      obstacles.push({ left: arrowRect.left, right: arrowRect.right });
    }
    if (isIPadMultitasking) {
      obstacles.push({ left: 0, right: WINDOW_CONTROLS_RIGHT });
    }
    const p = computeChipPlacement({
      wordmarkLeft: wordmarkRect.left,
      chipWidth,
      obstacles,
    });
    const next: Placed = {
      left: p.left - container.getBoundingClientRect().left,
      collapsed: p.collapsed,
      hidden: p.hidden,
    };
    setPlacement(prev => (samePlacement(prev, next) ? prev : next));
  }, [
    containerRef,
    wordmarkRef,
    backArrowRef,
    hasBackArrow,
    isIPadMultitasking,
  ]);

  // Re-measure when the arrow appears or goes (navigation, no resize), when
  // multitasking flips, and when the label changes; `measure` carries the first
  // two. The chip renders last in the header, so its siblings' refs (wordmark,
  // arrow) are set here; the container is its parent, whose ref React attaches
  // only after this effect when the two mount together (leaving
  // thread-fullscreen with the nodes read cached), hence the passive pass below.
  useLayoutEffect(() => {
    measure();
  }, [measure, nodeLabel, hasNode]);

  useEffect(() => {
    // Every ref is attached by now, including the parent container's.
    measure();
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(onResize);
    for (const el of [
      containerRef.current,
      wordmarkRef.current,
      measurerRef.current,
    ]) {
      if (el) observer.observe(el);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, [measure, containerRef, wordmarkRef, nodeLabel, hasNode]);

  // Touch hint: a long-press opens the popover; the click that ends it is
  // swallowed so it never opens Node Health.
  const [hintOpen, setHintOpen] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const clearPressTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  useEffect(() => clearPressTimer, []);
  // A long-press that ends without a click leaves the swallow armed, so the
  // next mouse, pen or keyboard activation would do nothing. Every new press
  // or key starts disarmed; a touch press re-arms through the timer that
  // touchstart starts (pointerdown fires first).
  const disarmSwallow = () => {
    longPressed.current = false;
  };

  // While the chip is not shown (hidden placement, not laid out) the popover
  // root is unmounted and cannot close itself: drop the hint, any pending
  // press and an armed click-swallow, so none of them surface when it returns.
  const shown = Boolean(placement && !placement.hidden);
  useEffect(() => {
    if (shown) return;
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    longPressed.current = false;
    setHintOpen(false);
  }, [shown]);

  if (!localNode) return null;

  const hint = titleBarChipHint(nodeLabel);

  return (
    <>
      {/* The hidden measurer: always rendered, always the full badge, never
          polling (its dot color does not change its width). */}
      <div
        ref={measurerRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0"
        data-testid="titlebar-node-chip-measurer"
      >
        <NodeBadge
          nodeId={localNode.nodeId}
          nodeLabel={nodeLabel}
          nodeStatus="online"
          labelAsReceived
          resourceHealth={false}
          interactive={false}
        />
      </div>
      {placement && !placement.hidden ? (
        <PopoverPrimitive.Root open={hintOpen} onOpenChange={setHintOpen}>
          <PopoverPrimitive.Anchor
            className="absolute top-1/2 z-10 flex -translate-y-1/2 select-none [-webkit-touch-callout:none]"
            style={{ left: placement.left }}
            data-testid="titlebar-node-chip"
            onPointerDownCapture={disarmSwallow}
            onKeyDownCapture={disarmSwallow}
            onTouchStartCapture={() => {
              longPressed.current = false;
              clearPressTimer();
              pressTimer.current = window.setTimeout(() => {
                pressTimer.current = null;
                longPressed.current = true;
                setHintOpen(true);
              }, LONG_PRESS_MS);
            }}
            onTouchMoveCapture={clearPressTimer}
            onTouchEndCapture={clearPressTimer}
            onTouchCancelCapture={clearPressTimer}
            onClickCapture={e => {
              if (longPressed.current) {
                longPressed.current = false;
                e.preventDefault();
                e.stopPropagation();
                return;
              }
              setHintOpen(false);
            }}
            onContextMenu={e => e.preventDefault()}
          >
            <NodeBadge
              nodeId={localNode.nodeId}
              nodeLabel={nodeLabel}
              nodeStatus="online"
              title={hint}
              collapsed={placement.collapsed}
              labelAsReceived
              resourceHealth={resourceHealth}
            />
          </PopoverPrimitive.Anchor>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              role="tooltip"
              side="bottom"
              sideOffset={4}
              onOpenAutoFocus={event => event.preventDefault()}
              onCloseAutoFocus={event => event.preventDefault()}
              className={HINT_CLASS}
              data-testid="titlebar-node-chip-hint"
            >
              {hint}
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      ) : null}
    </>
  );
}
