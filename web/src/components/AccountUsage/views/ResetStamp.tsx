// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState } from "react";
import { formatResetParts } from "./usageMeters";

/**
 * The absolute reset under an arc (#4467 R3): "Thu Oct 2 · 3:40 PM" on one line
 * whenever the column fits it, otherwise "Thu Oct 2" over "3:40 PM".
 *
 * The decision reads a hidden, always-rendered one-line copy (an invisible,
 * absolutely positioned `whitespace-nowrap` measurer), observed with a
 * `ResizeObserver` on the column. Measuring the visible stamp instead would
 * flip back and forth, because two lines stop overflowing.
 */
export function ResetStamp({ resetsAt }: { resetsAt: string | null }) {
  const parts = formatResetParts(resetsAt);
  const oneLine = parts ? `${parts.day} · ${parts.time}` : "";
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [twoLines, setTwoLines] = useState(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const update = () => setTwoLines(measure.scrollWidth > box.clientWidth + 1);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(box);
    return () => ro.disconnect();
  }, [oneLine]);

  if (!parts) return null;
  return (
    <div
      ref={boxRef}
      data-testid="reset-stamp"
      data-lines={twoLines ? "2" : "1"}
      className="relative w-full min-w-0 overflow-hidden text-center text-[length:var(--text-caption-xs)] leading-tight text-[var(--app-hint)]"
    >
      <span
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
      >
        {oneLine}
      </span>
      {twoLines ? (
        <>
          <span className="block">{parts.day}</span>
          <span className="block">{parts.time}</span>
        </>
      ) : (
        <span className="block whitespace-nowrap">{oneLine}</span>
      )}
    </div>
  );
}
