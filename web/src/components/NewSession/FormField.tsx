// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InfoIcon } from "@/components/icons";
import { BookmarkToggle } from "./bookmarkContext";
import { Button } from "@/components/ui/button";

export function FormField(props: {
  label: React.ReactNode;
  hint?: string;
  tooltip?: string;
  /** Saved-defaults bookmark id — renders the bookmark icon right of the info
   *  hint (no-op outside a CreateDefaultsProvider). */
  bookmarkId?: string;
  /** Generic trailing-action slot (#3456) rendered immediately right of the
   *  bookmark toggle — reusable by any field (e.g. the Federation Node refresh
   *  button). Renders nothing when omitted. */
  labelAction?: React.ReactNode;
  /** Longer explanatory text flowing inline after the icons (Git Type row). */
  inlineDescription?: string;
  /**
   * Keep the label on ONE line and push the info icon to the row's far right
   * (no gap, no icon padding). For a narrow column whose label would otherwise
   * wrap under its own icon — the Session Configuration modal's 118px
   * "Permission Mode" column (epic #3285 round 10, 2026-09-07): 12px/500 SF Pro
   * measures ~101px, and `gap-1` + the 16px icon box left it 98px.
   */
  nowrapLabel?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        className={`mb-0.5 flex items-center text-xs font-medium text-[var(--app-hint)] ${
          props.nowrapLabel ? "gap-0 whitespace-nowrap" : "gap-1"
        }`}
      >
        {props.label}
        {props.tooltip && (
          <Tooltip
            text={props.tooltip}
            align={props.nowrapLabel ? "end" : undefined}
          />
        )}
        {props.bookmarkId && <BookmarkToggle id={props.bookmarkId} />}
        {props.labelAction}
        {props.hint && (
          <span className="ml-1 font-normal text-[var(--app-hint)]/60">
            ({props.hint})
          </span>
        )}
        {props.inlineDescription && (
          <span className="ml-1.5 min-w-0 flex-1 text-[length:var(--text-caption-xs)] font-normal leading-tight text-[var(--app-hint)]">
            {props.inlineDescription}
          </span>
        )}
      </label>
      {props.children}
    </div>
  );
}

export function Tooltip(props: {
  text: string;
  /** `"end"`: pin the trigger to the label row's far right with no padding
   *  (FormField `nowrapLabel`). */
  align?: "end";
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Close on outside click — check both trigger and portal-rendered tooltip
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        tooltipRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open]);

  // Close on scroll (prevents tooltip from drifting away from trigger)
  useEffect(() => {
    if (!open) return;
    const handler = () => setOpen(false);
    window.addEventListener("scroll", handler, true);
    return () => window.removeEventListener("scroll", handler, true);
  }, [open]);

  const end = props.align === "end";
  return (
    <span className={end ? "ml-auto inline-flex" : "inline-flex"}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghostStatic"
        onClick={() => setOpen(o => !o)}
        className={`h-auto cursor-help rounded-none hover:text-[var(--app-fg)] ${end ? "p-0" : "p-0.5"}`}
        aria-label="More info"
      >
        <InfoIcon className="h-3 w-3 text-[var(--app-hint)]/60" />
      </Button>
      {open && (
        <TooltipPortal
          triggerRef={triggerRef}
          tooltipRef={tooltipRef}
          text={props.text}
        />
      )}
    </span>
  );
}

/** Portal-rendered tooltip that escapes overflow-hidden parents */
function TooltipPortal(props: {
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  tooltipRef: React.RefObject<HTMLDivElement | null>;
  text: string;
}) {
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    visibility: "hidden",
    zIndex: 9999,
  });

  useEffect(() => {
    if (!props.triggerRef.current) return;
    const rect = props.triggerRef.current.getBoundingClientRect();
    const tooltipW = 224; // w-56 = 14rem = 224px
    const pad = 8;

    // Horizontal: center on trigger, clamp to viewport edges
    let left = rect.left + rect.width / 2 - tooltipW / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - pad - tooltipW));

    // Vertical: render below trigger (natural for mobile — user sees tooltip
    // below their finger, not hidden under it)
    const top = rect.bottom + 6;

    setStyle({
      position: "fixed",
      top,
      left,
      width: tooltipW,
      zIndex: 9999,
      visibility: "visible",
    });
  }, [props.triggerRef]);

  // After tooltip renders, check if it extends below viewport and adjust
  useEffect(() => {
    if (!props.tooltipRef.current || !props.triggerRef.current) return;
    const tooltipRect = props.tooltipRef.current.getBoundingClientRect();
    const triggerRect = props.triggerRef.current.getBoundingClientRect();

    if (tooltipRect.bottom > window.innerHeight - 8) {
      // Try above trigger instead
      const aboveTop = triggerRect.top - tooltipRect.height - 6;
      if (aboveTop >= 8) {
        setStyle(prev => ({ ...prev, top: aboveTop }));
      }
    }
  }, [props.tooltipRef, props.triggerRef, style.top]);

  return createPortal(
    <div
      ref={props.tooltipRef}
      style={style}
      className="rounded-lg bg-[var(--app-secondary-bg)] border border-[var(--app-border)] px-3 py-2 text-xs text-[var(--app-fg)] shadow-lg"
    >
      {props.text}
    </div>,
    document.body
  );
}
