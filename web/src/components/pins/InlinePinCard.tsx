// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ApiClient } from "@/api/client";
import { CompletedPinRow } from "@/components/pins/CompletedPinRow";
import { PinRow } from "@/components/pins/PinRow";
import {
  PinsContext,
  type PinsContextValue,
} from "@/components/pins/pinsShared";
import {
  useMarkPinSeen,
  usePinRecord,
  useStarPin,
} from "@/hooks/queries/usePins";
import { formatPinAge, formatPinTime, toPinViewModel } from "@/lib/pins/ledger";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { resolvePinZone } from "@/lib/pins/zoneTime";

// ── One tooltip observer for every inline card ──────────────────────────────
// A chat can hold many cards (the list is not virtualized), and an observer per
// card cost 159-914 ms for 100-500 armed rows (pinsShared.tsx). One observer,
// rooted in the viewport with a screen of margin; a card never disarms.

const armCallbacks = new Map<Element, () => void>();
let armObserver: IntersectionObserver | null = null;

function observeForArming(element: Element, arm: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    arm();
    return () => {};
  }
  armObserver ??= new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        armCallbacks.get(entry.target)?.();
        armCallbacks.delete(entry.target);
        armObserver?.unobserve(entry.target);
      }
    },
    { root: null, rootMargin: "100% 0px" }
  );
  armCallbacks.set(element, arm);
  armObserver.observe(element);
  return () => {
    armCallbacks.delete(element);
    armObserver?.unobserve(element);
  };
}

function useInlineArming(): {
  armed: boolean;
  observe: (key: string, element: Element | null) => void;
} {
  const [armed, setArmed] = useState(false);
  const [element, setElement] = useState<Element | null>(null);
  useEffect(() => {
    if (armed || !element) return;
    return observeForArming(element, () => setArmed(true));
  }, [armed, element]);
  const observe = useCallback(
    (_key: string, next: Element | null) => setElement(next),
    []
  );
  return { armed, observe };
}

/**
 * #6450: a pin's live record where the chat raised it (R1), the same state the
 * Pins tab shows: a choice made here shows there at once, and the reverse.
 * Collapsed by default, because an expanded pin marks itself seen and starts its
 * evidence reads, and the chat is not virtualized. Open pins render the Action
 * Items row, settled ones the Completed row; a dashboard, a missing pin or a
 * closed gate render `fallback` (the fence as a code block, or nothing for a
 * tool call). Loaded data stays on screen through a failed background refetch.
 */
export default function InlinePinCard(props: {
  api: ApiClient;
  sessionId: string;
  pinKey: string;
  sessionActive: boolean;
  fallback: ReactNode;
}) {
  const { api, sessionId, pinKey, sessionActive, fallback } = props;
  const record = usePinRecord(api, sessionId, pinKey, true);
  const starPin = useStarPin(api, sessionId);
  const markSeen = useMarkPinSeen(api, sessionId);
  const [expanded, setExpanded] = useState(false);
  const { armed, observe } = useInlineArming();
  const now = useMinuteNow();
  const toggle = useCallback(() => setExpanded(on => !on), []);
  const pin = record.data?.kind === "ready" ? record.data.pin : null;
  const model = useMemo(() => (pin ? toPinViewModel(pin) : null), [pin]);
  const recordZone =
    record.data?.kind === "ready" ? (record.data.timeZone ?? null) : null;
  const timeZone = useMemo(() => resolvePinZone(recordZone), [recordZone]);
  const context = useMemo<PinsContextValue>(
    () => ({ api, sessionId, sessionActive, markSeen, via: "chat", timeZone }),
    [api, sessionId, sessionActive, markSeen, timeZone]
  );

  if (!model) {
    return record.isPending ? (
      <div
        aria-busy="true"
        className="my-1 rounded-md border border-[var(--app-border)]"
        style={{ minHeight: "34px" }}
      />
    ) : (
      <>{fallback}</>
    );
  }
  if (model.pin.kind === "dashboard") return <>{fallback}</>;

  const settled = model.pin.status !== "open" && model.pin.status !== "live";
  return (
    <PinsContext.Provider value={context}>
      <div data-pin-card={model.pin.key} className="my-1 rounded-md">
        {settled ? (
          <CompletedPinRow
            model={model}
            expanded={expanded}
            armed={armed}
            onToggle={toggle}
            observe={observe}
            mode="chat"
          />
        ) : (
          <PinRow
            model={model}
            expanded={expanded}
            ageLabel={formatPinAge(model.pin.createdAt, now)}
            ageTooltip={`Raised ${formatPinTime(model.pin.createdAt, timeZone)}`}
            armed={armed}
            onToggle={toggle}
            onStar={starPin}
            observe={observe}
            mode="chat"
          />
        )}
      </div>
    </PinsContext.Provider>
  );
}
