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
import { Activity, ExternalLink } from "lucide-react";
import { NodeBadge } from "@/components/NodeBadge";
import { NodeHealthModal } from "@/components/NodeHealthModal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_TITLE } from "@/components/ui/menuPrimitives";
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
import {
  buildNodeSwitchRows,
  hasOtherNodes,
  NODE_STATUS_TEXT_CLASS,
  type NodeSwitchRow,
} from "@/lib/nodeSwitcher";

/**
 * TitleBarNodeChip — the UI host node's `NodeBadge` in the app title bar
 * (issue #4468, epic #4460 Sub-Issue H): it shows at all times which node's web
 * UI the user is in. The chip is the UI host; a session header's badge is that
 * session's node. The two may differ and look identical by design.
 *
 * Position (`computeChipPlacement`): the chip's center sits halfway between the
 * content column's letterbox (0 wide until the window is wider than the column)
 * and the measured wordmark `<Link>`'s left edge, nudged right past the back
 * arrow (and, while
 * iPad multitasking, the window-control zone — ruling H-1 A), collapsed to the
 * health dot when it would pass the wordmark's clearance gap, and not rendered
 * when even the dot would.
 *
 * Node switcher (issue #6123): when the federation nodes read lists at least
 * one other node, the chip is a `DropdownMenu` trigger. The menu's header says
 * "You are using <node>'s web UI" (it replaces the long-press hint, which could
 * not coexist: Radix opens a menu on pointerdown), the UI host is the first row
 * marked current, every other node with a valid web address opens its web UI
 * in this tab, a node that is offline or has no valid address is listed but
 * disabled ("offline" / "no address"), and a "Node health" row opens the Node
 * Health modal. The menu refetches the nodes read when it opens.
 *
 * With no other node (a standalone install, every customer VM, a spoke, a
 * worktree instance — ruling D4 A) the chip is exactly as #4468 shipped it:
 * hover shows the hint through the badge's `title`; on touch a 500ms
 * long-press opens the same text in a small popover and swallows the click that
 * ends it (capture phase, because `NodeBadge` stops propagation at its button);
 * a plain tap opens the Node Health modal.
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

/**
 * A highlighted (hovered or keyboard-focused) node row takes the menu's
 * standard mint highlight (`focus:bg-accent`). Its coloured secondary text
 * switches to the highlight's dark foreground there, or it would vanish into
 * the mint. Applies under a `group` row only.
 */
const ROW_HIGHLIGHT_TEXT = "group-data-[highlighted]:text-accent-foreground";

/** The status word on a node row, coloured like the Node Health modal's. */
function NodeRowStatus({ row }: { row: NodeSwitchRow }): ReactElement {
  if (row.current) {
    return (
      <span className="shrink-0 text-[length:var(--text-caption)] font-medium">
        current
      </span>
    );
  }
  // An online or degraded node with no valid web address cannot be opened.
  const noAddress = !row.href && row.status !== "offline";
  return (
    <span
      className={`shrink-0 text-[length:var(--text-caption)] font-medium ${
        noAddress
          ? "text-[var(--app-hint)]"
          : NODE_STATUS_TEXT_CLASS[row.status]
      } ${ROW_HIGHLIGHT_TEXT}`}
    >
      {noAddress ? "no address" : row.status}
    </span>
  );
}

/**
 * The width of the brand letterbox left of the header's inner container: the
 * used value of its `mx-auto` margin, which is 0 until the window is wider than
 * the content column (`max-w-content`). The chip is placed right of it, so it
 * never sits out in the letterbox. An unreadable value (jsdom) counts as 0.
 */
function letterboxWidth(container: HTMLElement): number {
  const margin = Number.parseFloat(getComputedStyle(container).marginLeft);
  return Number.isFinite(margin) && margin > 0 ? margin : 0;
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
      leftBound: letterboxWidth(container),
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

  // #6123: the switcher menu's "Node health" row opens this chip-level modal (a
  // sibling of the menu, never inside its trigger or content: portal events
  // bubble through the React tree). The ref keeps the closing menu from pulling
  // focus back to the trigger while the dialog takes it.
  const [healthOpen, setHealthOpen] = useState(false);
  const openingHealth = useRef(false);

  // While the chip is not shown (hidden placement, not laid out) the popover
  // root is unmounted and cannot close itself: drop the hint, any pending
  // press and an armed click-swallow, so none of them surface when it returns.
  // Also close the switcher's Node Health modal, which renders outside the
  // hidden branch and would otherwise outlive the chip.
  const shown = Boolean(placement && !placement.hidden);
  useEffect(() => {
    if (shown) return;
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    longPressed.current = false;
    setHintOpen(false);
    setHealthOpen(false);
  }, [shown]);

  if (!localNode) return null;

  const hint = titleBarChipHint(nodeLabel);
  const rows = buildNodeSwitchRows(data);
  const switcher = hasOtherNodes(rows);

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
      {placement && !placement.hidden && switcher ? (
        // #6123: not modal — a modal menu closing under the opening Node
        // Health dialog can leave the page unclickable (BrowseRow.tsx).
        <DropdownMenu
          modal={false}
          onOpenChange={open => {
            if (open) void refetch();
          }}
        >
          <DropdownMenuTrigger asChild>
            {/* Zero padding (`size="bare"`), so the trigger is exactly the
                measurer's width and the placement thresholds still hold. The
                badge is static: the interactive one stops pointerdown, which
                is the event Radix opens the menu on. */}
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              className="absolute top-1/2 z-10 flex -translate-y-1/2 select-none font-normal hover:opacity-80 [-webkit-touch-callout:none]"
              style={{ left: placement.left }}
              aria-label={`${nodeLabel} — switch node`}
              data-testid="titlebar-node-chip"
              data-switcher="true"
              onContextMenu={e => e.preventDefault()}
            >
              <NodeBadge
                nodeId={localNode.nodeId}
                nodeLabel={nodeLabel}
                nodeStatus="online"
                title={`${hint} — switch node`}
                collapsed={placement.collapsed}
                labelAsReceived
                resourceHealth={resourceHealth}
                interactive={false}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="chip-scope max-h-[85vh] min-w-[220px] max-w-[calc(100vw-16px)] overflow-y-auto p-0.5" /* design-tokens-allow: 220px menu min-width fits badge + status + host on one row at 393px; no spacing token that wide */
            data-testid="titlebar-node-menu"
            onCloseAutoFocus={event => {
              // Keyboard users get focus back on the chip, except when the
              // menu closes because Node Health is opening and needs it.
              if (openingHealth.current) {
                openingHealth.current = false;
                event.preventDefault();
              }
            }}
          >
            <DropdownMenuLabel
              className={MENU_TITLE}
              data-testid="titlebar-node-menu-hint"
            >
              {hint}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="my-0.5" />
            {rows.map(row => {
              const badge = (
                <NodeBadge
                  nodeId={row.nodeId}
                  nodeLabel={row.nodeLabel}
                  nodeUrl={row.nodeUrl}
                  nodeStatus={row.status}
                  labelAsReceived={row.current}
                  resourceHealth={resourceHealth}
                  interactive={false}
                />
              );
              if (row.current) {
                return (
                  <DropdownMenuItem
                    key={row.nodeId}
                    className="bg-[var(--app-accent)]/15 text-[var(--app-accent)] focus:bg-[var(--app-accent)]/20 focus:text-[var(--app-accent)]"
                    title={hint}
                    data-testid={`titlebar-node-row-${row.nodeId}`}
                    data-current="true"
                  >
                    {badge}
                    <NodeRowStatus row={row} />
                  </DropdownMenuItem>
                );
              }
              if (!row.href) {
                // Disabled items take no pointer events, so a title would
                // never show: the reason is the visible status word.
                return (
                  <DropdownMenuItem
                    key={row.nodeId}
                    disabled
                    data-testid={`titlebar-node-row-${row.nodeId}`}
                  >
                    {badge}
                    <NodeRowStatus row={row} />
                  </DropdownMenuItem>
                );
              }
              return (
                <DropdownMenuItem
                  key={row.nodeId}
                  asChild
                  className="group"
                  data-testid={`titlebar-node-row-${row.nodeId}`}
                >
                  {/* Same tab (D3, ruled by Matt 2026-11-07): choosing a
                      node replaces this page with that node's web UI. */}
                  <a
                    href={row.href}
                    title={`Open ${row.nodeLabel}'s web UI`}
                    className="no-underline"
                  >
                    {badge}
                    <NodeRowStatus row={row} />
                    <span
                      className={`min-w-0 flex-1 truncate text-[var(--app-hint)] ${ROW_HIGHLIGHT_TEXT}`}
                    >
                      {row.host}
                    </span>
                    <ExternalLink aria-hidden="true" />
                  </a>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator className="my-0.5" />
            <DropdownMenuItem
              title={`Health and resource metrics for ${nodeLabel}`}
              data-testid="titlebar-node-menu-health"
              onSelect={() => {
                openingHealth.current = true;
                setHealthOpen(true);
              }}
            >
              <Activity aria-hidden="true" />
              Node health
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : placement && !placement.hidden ? (
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
      {healthOpen ? (
        <NodeHealthModal
          nodeId={localNode.nodeId}
          nodeLabel={nodeLabel}
          nodeStatus="online"
          labelAsReceived
          open={healthOpen}
          onOpenChange={setHealthOpen}
        />
      ) : null}
    </>
  );
}
