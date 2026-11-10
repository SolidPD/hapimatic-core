// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scroll-cause recorder (issue #6122). A diagnostic, OFF by default, that logs every change
 * to a chat thread viewport's `scrollTop` with the mechanism that caused it, so a jumping
 * thread can be measured on a real device instead of guessed at (eight earlier fixes in this
 * area did not hold).
 *
 * It ships in production builds behind a runtime switch, because the reproduction that
 * matters is the operator's iPhone PWA: Settings → Preferences → Diagnostics, or
 * `?scrollrec=1` / `?scrollrec=0`. The installed PWA cannot take URL parameters and does not
 * share storage with Safari, so the Settings toggle is the reliable path there.
 *
 * Cost model:
 * - While off, every export is a cheap early return and `registerThreadViewport` attaches
 *   nothing: no listener, no observer, no property wrapper.
 * - While on, it keeps a bounded ring buffer (no React state, no per-event console output).
 *   Its own listeners read no layout in wheel, touch or key handlers; layout is read in scroll
 *   events, animation frames, and when a writer tags a write.
 *
 * How a cause is assigned:
 * 1. Programmatic writers call `recordScrollWrite` right after they write. The browser's
 *    resulting scroll event is folded into that entry.
 * 2. Otherwise the scroll event takes the most recent user input: wheel or keyboard within
 *    1 s, touch while a finger is down, momentum up to 3 s after the finger lifts.
 * 3. Otherwise it is `unattributed`, which is how an unknown writer shows itself.
 * In addition, a debug-only wrapper on the viewport's own `scrollTop` / `scrollTo` /
 * `scrollBy` and on `Element.prototype.scrollIntoView` logs any write nobody tagged as
 * `untagged-write`, with a short stack.
 *
 * See `docs/internal/architecture/chat-thread-scroll.md` for the writer inventory.
 */

import { getStorageKey } from "@/lib/storage-keys";
import { getClientVersion } from "@/lib/app-version";

const FLAG_KEY = "hapi:scroll-recorder:v1";
/** Ring-buffer capacity. Same-cause user scroll events coalesce, so this covers minutes. */
export const SCROLL_LOG_MAX_ENTRIES = 3000;
/** A scroll event this soon after a tagged write, landing on its value, belongs to it. */
const FOLD_WINDOW_MS = 100;
/** Wheel / keyboard input attributes scroll events for this long. */
const INPUT_WINDOW_MS = 1000;
/** iOS momentum keeps scrolling after the finger lifts. */
const MOMENTUM_WINDOW_MS = 3000;
/** Consecutive same-cause user scroll events closer than this merge into one entry. */
const COALESCE_GAP_MS = 250;
const NAV_KEYS = new Set([
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  " ",
]);
/**
 * Writes that keep the text in place (they offset a change above the reader). Every other
 * tagged write moves the view on purpose.
 */
const COMPENSATION_CAUSES: ReadonlySet<string> = new Set([
  "reading-anchor-compensation",
  "text-scale-restore",
]);
/**
 * Message-level elements, in document order; a strip sits at or below its message root's top,
 * so their tops never decrease.
 */
const PROBE_SELECTOR = "[data-bookmark-message], [data-message-id]";
// A hit that contains whole messages or blocks is a container, which does not move when
// content inside it, above the reading line, changes; the probe looks further down.
const PROBE_CONTAINER_SELECTOR =
  "[data-bookmark-anchor], [data-message-id], [data-bookmark-message]";

export interface ScrollLogEntry {
  t: number;
  tEnd?: number;
  cause: string;
  before: number;
  after: number;
  sh: number;
  ch: number;
  follow: 0 | 1;
  dir: string;
  pend: 0 | 1;
  touch: 0 | 1;
  n: number;
  vp: string;
  detail?: string;
}

/** Live thread state HappyThread exposes so each entry records the context it happened in. */
export interface ThreadScrollState {
  following: boolean;
  direction: "up" | "down" | null;
  loadOlderPending: boolean;
}

/**
 * What the user was reading, and its offset from the content column's top: the element at
 * the reading line, held by identity (`el`), or, when no reading-line element qualifies (or
 * the browser cannot hit-test), the first message at or below the top edge, by id. The offset
 * is content-relative, so a user scroll never changes it.
 */
interface ProbeRef {
  attr: "data-message-id" | "data-bookmark-message" | null;
  id: string;
  offset: number;
  el?: HTMLElement;
}

interface PendingUntagged {
  el: HTMLElement;
  before: number;
  after: number;
  via: string;
  stack: string;
}

interface Registration {
  viewport: HTMLElement;
  content: HTMLElement;
  label: string;
  getState: () => ThreadScrollState;
  touchDown: boolean;
  touchEndAt: number;
  lastInput: { kind: "wheel" | "keyboard"; t: number } | null;
  lastTagged: { after: number; t: number; index: number } | null;
  probe: ProbeRef | null;
  // Since the probe: what compensation writes moved the viewport by, and whether a write
  // moved the view on purpose (a jump, a restore, a navigator snap).
  compensationSinceProbe: number;
  navWriteSinceProbe: boolean;
  probeFrame: number | null;
  shiftFrame: number | null;
}

// ── Module state ────────────────────────────────────────────────────────────

const ring: (ScrollLogEntry | undefined)[] = new Array(SCROLL_LOG_MAX_ENTRIES);
let ringStart = 0;
let ringSize = 0;
const registrations = new Map<HTMLElement, Registration>();
const listeners = new Set<() => void>();
let pendingUntagged: PendingUntagged[] = [];
let untaggedFlushScheduled = false;
let originalScrollIntoView:
  | ((this: Element, arg?: boolean | ScrollIntoViewOptions) => void)
  | null = null;

function now(): number {
  return Math.round(
    typeof performance !== "undefined" ? performance.now() : Date.now()
  );
}

// ── Flag ────────────────────────────────────────────────────────────────────

/** True when the operator switched the recorder on for this device and instance. */
export function isScrollRecorderEnabled(): boolean {
  try {
    return localStorage.getItem(getStorageKey(FLAG_KEY)) === "1";
  } catch {
    return false;
  }
}

/**
 * Persist the switch. Takes effect the next time a thread mounts. Returns whether the
 * stored switch now reads `on`: false when storage refused the write.
 */
export function setScrollRecorderEnabled(on: boolean): boolean {
  try {
    if (on) localStorage.setItem(getStorageKey(FLAG_KEY), "1");
    else localStorage.removeItem(getStorageKey(FLAG_KEY));
  } catch {
    /* storage unavailable (private mode / quota): the switch keeps its stored value */
  }
  notify();
  return isScrollRecorderEnabled() === on;
}

/** `?scrollrec=1` switches the recorder on, `?scrollrec=0` switches it off. */
export function applyScrollRecorderUrlParam(search: string): void {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get("scrollrec");
  } catch {
    return;
  }
  if (value === "1") setScrollRecorderEnabled(true);
  else if (value === "0") setScrollRecorderEnabled(false);
}

// ── Log storage ─────────────────────────────────────────────────────────────

function push(entry: ScrollLogEntry): number {
  const index = (ringStart + ringSize) % SCROLL_LOG_MAX_ENTRIES;
  ring[index] = entry;
  if (ringSize < SCROLL_LOG_MAX_ENTRIES) ringSize += 1;
  else ringStart = (ringStart + 1) % SCROLL_LOG_MAX_ENTRIES;
  notify();
  return index;
}

function lastEntry(): ScrollLogEntry | undefined {
  if (ringSize === 0) return undefined;
  return ring[(ringStart + ringSize - 1) % SCROLL_LOG_MAX_ENTRIES];
}

/** Entries oldest first. */
export function getScrollLogEntries(): ScrollLogEntry[] {
  const out: ScrollLogEntry[] = [];
  for (let i = 0; i < ringSize; i++) {
    const entry = ring[(ringStart + i) % SCROLL_LOG_MAX_ENTRIES];
    if (entry) out.push(entry);
  }
  return out;
}

export function getScrollLogSize(): number {
  return ringSize;
}

export function clearScrollLog(): void {
  ring.fill(undefined);
  ringStart = 0;
  ringSize = 0;
  for (const reg of registrations.values()) reg.lastTagged = null;
  notify();
}

/** Re-render hook for the in-thread panel's entry count. */
export function subscribeScrollLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

// ── Recording API ───────────────────────────────────────────────────────────

function entryFor(
  reg: Registration,
  cause: string,
  before: number,
  after: number,
  detail?: string
): ScrollLogEntry {
  const state = reg.getState();
  return {
    t: now(),
    cause,
    before: Math.round(before),
    after: Math.round(after),
    sh: Math.round(reg.viewport.scrollHeight),
    ch: Math.round(reg.viewport.clientHeight),
    follow: state.following ? 1 : 0,
    dir:
      state.direction === "up" ? "u" : state.direction === "down" ? "d" : "-",
    pend: state.loadOlderPending ? 1 : 0,
    touch: reg.touchDown || now() - reg.touchEndAt < MOMENTUM_WINDOW_MS ? 1 : 0,
    n: 1,
    vp: reg.label,
    detail,
  };
}

/**
 * Tag a programmatic write to a registered thread viewport. Call it synchronously right after
 * the write, with `after` read back. Writes to any other element are ignored.
 */
export function recordScrollWrite(
  cause: string,
  el: Element | null | undefined,
  before: number,
  after: number,
  detail?: string
): void {
  if (registrations.size === 0 || !el) return;
  const reg = registrations.get(el as HTMLElement);
  if (!reg) return;
  // This write is accounted for: drop the matching untagged candidate the wrapper queued.
  pendingUntagged = pendingUntagged.filter(
    p => !(p.el === el && Math.abs(p.after - after) < 1)
  );
  const index = push(entryFor(reg, cause, before, after, detail));
  reg.lastTagged = { after, t: now(), index };
  if (COMPENSATION_CAUSES.has(cause))
    reg.compensationSinceProbe += after - before;
  else reg.navWriteSinceProbe = true;
}

/** Log a non-write event (load-older lifecycle, follow changes, anchor events, timings). */
export function recordEvent(
  kind: string,
  detail?: string,
  el?: Element | null
): void {
  if (registrations.size === 0) return;
  const reg =
    (el ? registrations.get(el as HTMLElement) : undefined) ??
    registrations.values().next().value;
  if (!reg) return;
  const top = reg.viewport.scrollTop;
  push(entryFor(reg, kind, top, top, detail));
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Start recording one thread viewport. Returns a disposer. A no-op (nothing attached) while
 * the recorder is switched off.
 */
export function registerThreadViewport(
  viewport: HTMLElement | null,
  content: HTMLElement | null,
  options: { label?: string; getState?: () => ThreadScrollState } = {}
): () => void {
  if (!viewport || !content) return () => {};
  if (typeof window !== "undefined") {
    applyScrollRecorderUrlParam(window.location.search);
  }
  if (!isScrollRecorderEnabled()) return () => {};
  if (registrations.has(viewport)) return () => {};

  const reg: Registration = {
    viewport,
    content,
    label: (options.label ?? "thread").slice(-6),
    getState:
      options.getState ??
      (() => ({ following: false, direction: null, loadOlderPending: false })),
    touchDown: false,
    touchEndAt: -Infinity,
    lastInput: null,
    lastTagged: null,
    probe: null,
    compensationSinceProbe: 0,
    navWriteSinceProbe: false,
    probeFrame: null,
    shiftFrame: null,
  };
  registrations.set(viewport, reg);
  exposeWindowApi();

  const abort = new AbortController();
  const opts = { passive: true, capture: true, signal: abort.signal };
  viewport.addEventListener("scroll", () => onScroll(reg), opts);
  viewport.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      if (event.ctrlKey) return; // browser zoom, not a scroll (#6213)
      reg.lastInput = { kind: "wheel", t: now() };
    },
    opts
  );
  viewport.addEventListener(
    "touchstart",
    () => {
      reg.touchDown = true;
    },
    opts
  );
  viewport.addEventListener(
    "touchend",
    () => {
      reg.touchDown = false;
      reg.touchEndAt = now();
    },
    opts
  );
  window.addEventListener(
    "keydown",
    (event: KeyboardEvent) => {
      if (!NAV_KEYS.has(event.key)) return;
      reg.lastInput = { kind: "keyboard", t: now() };
    },
    opts
  );

  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => scheduleShiftCheck(reg));
  observer?.observe(content);

  const unwrap = wrapViewportWrites(reg);
  push({
    ...entryFor(reg, "recorder-start", viewport.scrollTop, viewport.scrollTop),
    detail: headerDetail(),
  });

  return () => {
    abort.abort();
    observer?.disconnect();
    if (reg.probeFrame !== null) cancelAnimationFrame(reg.probeFrame);
    if (reg.shiftFrame !== null) cancelAnimationFrame(reg.shiftFrame);
    unwrap();
    registrations.delete(viewport);
    if (registrations.size === 0) restoreScrollIntoView();
  };
}

function onScroll(reg: Registration): void {
  const top = reg.viewport.scrollTop;
  const t = now();
  const tagged = reg.lastTagged;
  if (
    tagged &&
    t - tagged.t <= FOLD_WINDOW_MS &&
    Math.abs(top - tagged.after) < 1
  ) {
    const entry = ring[tagged.index];
    if (entry) entry.n += 1;
    scheduleProbe(reg);
    return;
  }
  let cause = "unattributed";
  if (reg.touchDown) cause = "user-touch";
  else if (t - reg.touchEndAt < MOMENTUM_WINDOW_MS) cause = "user-momentum";
  else if (reg.lastInput && t - reg.lastInput.t < INPUT_WINDOW_MS) {
    cause = reg.lastInput.kind === "wheel" ? "user-wheel" : "user-keyboard";
  }
  const prev = lastEntry();
  if (
    prev &&
    prev.cause === cause &&
    prev.vp === reg.label &&
    t - (prev.tEnd ?? prev.t) < COALESCE_GAP_MS
  ) {
    prev.after = Math.round(top);
    prev.tEnd = t;
    prev.n += 1;
    prev.sh = Math.round(reg.viewport.scrollHeight);
    notify();
  } else {
    const before = prev && prev.vp === reg.label ? prev.after : top;
    push(entryFor(reg, cause, before, top));
  }
  scheduleProbe(reg);
}

// ── Uncompensated-shift detector ────────────────────────────────────────────

/**
 * The element at the reading line (#6122): what the browser hit-tests just below the
 * viewport's top edge, inside the message list. A message-level probe sits below the line, so
 * on-screen growth between the two (an image decoding, a tool card mounting) read as a shift of
 * the reader's text when the text under the reader had not moved. This is its own hit test,
 * not the reading anchor's, so the recorder stays an independent check of it.
 */
function findReadingLineProbe(reg: Registration): ProbeRef | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const v = reg.viewport.getBoundingClientRect();
  if (v.height <= 0 || v.width <= 0) return null;
  const list =
    reg.content.querySelector<HTMLElement>("[data-thread-message-list]") ??
    reg.content;
  const end = v.top + Math.min(v.height / 3, 240);
  for (let y = v.top + 2; y <= end; y += 24) {
    const hit = document.elementFromPoint(v.left + v.width * 0.4, y);
    if (!(hit instanceof HTMLElement) || hit === list || !list.contains(hit)) {
      continue;
    }
    if (hit.querySelector(PROBE_CONTAINER_SELECTOR) !== null) continue;
    return {
      attr: null,
      id: `line:${hit.tagName.toLowerCase()}`,
      offset: contentOffsetOf(reg, hit),
      el: hit,
    };
  }
  return null;
}

function contentOffsetOf(reg: Registration, el: HTMLElement): number {
  return (
    el.getBoundingClientRect().top - reg.content.getBoundingClientRect().top
  );
}

/**
 * The probe: the reading-line element when the browser can hit-test and something
 * qualifies. Otherwise the first message-level element at or below the viewport's top edge
 * (binary search), held by its message id, so a DOM node reused for another message cannot
 * hide a shift.
 */
function findProbe(reg: Registration): ProbeRef | null {
  const line = findReadingLineProbe(reg);
  if (line) return line;
  const nodes = reg.content.querySelectorAll<HTMLElement>(PROBE_SELECTOR);
  if (nodes.length === 0) return null;
  const viewportTop = reg.viewport.getBoundingClientRect().top;
  let lo = 0;
  let hi = nodes.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].getBoundingClientRect().top >= viewportTop - 0.5) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const el = nodes[found === -1 ? nodes.length - 1 : found];
  const attr = el.hasAttribute("data-message-id")
    ? "data-message-id"
    : "data-bookmark-message";
  const id = el.getAttribute(attr);
  if (!id) return null;
  return { attr, id, offset: contentOffsetOf(reg, el) };
}

function findProbeElement(
  reg: Registration,
  probe: ProbeRef
): HTMLElement | null {
  // A line probe is held by identity: if a re-render replaced it, there is nothing to measure.
  if (probe.el) {
    return probe.el.isConnected && reg.content.contains(probe.el)
      ? probe.el
      : null;
  }
  if (probe.attr === null) return null;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(probe.id)
      : probe.id.replace(/["\\]/g, "\\$&");
  return reg.content.querySelector<HTMLElement>(`[${probe.attr}="${escaped}"]`);
}

/**
 * Check the held probe, then take a new one. The text under the reader moved on screen, apart
 * from scrolling, by its content offset's change minus what compensation writes moved the
 * viewport since the probe. That holds during a gesture too, so a shift that lands while the
 * user scrolls or touches is checked, not absorbed into the next probe. A write that moved
 * the view on purpose since the probe skips one check: the reader is somewhere new.
 */
function checkAndReprobe(reg: Registration): void {
  const probe = reg.probe;
  const el = probe ? findProbeElement(reg, probe) : null;
  // While following, new content is meant to push earlier text up: the reader is watching
  // the tail, so a move there is not a shift of the text being read.
  if (probe && el && !reg.navWriteSinceProbe && !reg.getState().following) {
    const moved =
      contentOffsetOf(reg, el) - probe.offset - reg.compensationSinceProbe;
    if (Math.abs(moved) >= 1) {
      const top = reg.viewport.scrollTop;
      push(
        entryFor(
          reg,
          "uncompensated-shift",
          top,
          top,
          `by=${Math.round(moved)} anchor=${probe.id.slice(-8)}`
        )
      );
    }
  }
  reg.probe = findProbe(reg);
  reg.compensationSinceProbe = 0;
  reg.navWriteSinceProbe = false;
}

function scheduleProbe(reg: Registration): void {
  if (reg.probeFrame !== null || typeof requestAnimationFrame === "undefined")
    return;
  reg.probeFrame = requestAnimationFrame(() => {
    reg.probeFrame = null;
    checkAndReprobe(reg);
  });
}

function scheduleShiftCheck(reg: Registration): void {
  if (reg.shiftFrame !== null || typeof requestAnimationFrame === "undefined")
    return;
  // Evaluate one frame later, after every ResizeObserver callback (HappyThread's
  // compensation included) has run, so a compensated resize is not misreported.
  reg.shiftFrame = requestAnimationFrame(() => {
    reg.shiftFrame = null;
    checkAndReprobe(reg);
  });
}

// ── Untagged-write catcher ──────────────────────────────────────────────────

function shortStack(): string {
  const lines = (new Error().stack ?? "").split("\n").slice(3, 7);
  return lines.map(line => line.trim().replace(/^at /, "")).join(" < ");
}

function queueUntagged(candidate: PendingUntagged): void {
  if (Math.abs(candidate.after - candidate.before) < 1) return;
  pendingUntagged.push(candidate);
  if (untaggedFlushScheduled) return;
  untaggedFlushScheduled = true;
  // A tagged writer calls recordScrollWrite right after its write, in the same task; the
  // microtask runs after it, so anything still queued here was written by nobody we know.
  queueMicrotask(() => {
    untaggedFlushScheduled = false;
    const batch = pendingUntagged;
    pendingUntagged = [];
    for (const p of batch) {
      const reg = registrations.get(p.el);
      if (!reg) continue;
      push(
        entryFor(
          reg,
          "untagged-write",
          p.before,
          p.after,
          `${p.via} ${p.stack}`
        )
      );
    }
  });
}

function wrapViewportWrites(reg: Registration): () => void {
  const el = reg.viewport;
  const proto = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const restorers: (() => void)[] = [];
  if (proto?.get && proto.set) {
    const getTop = proto.get;
    const setTop = proto.set;
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get() {
        return getTop.call(this);
      },
      set(value: number) {
        const before = getTop.call(this) as number;
        setTop.call(this, value);
        queueUntagged({
          el,
          before,
          after: getTop.call(this) as number,
          via: "scrollTop=",
          stack: shortStack(),
        });
      },
    });
    restorers.push(() => {
      delete (el as unknown as Record<string, unknown>).scrollTop;
    });
  }
  for (const method of ["scrollTo", "scrollBy"] as const) {
    const original = el[method];
    if (typeof original !== "function") continue;
    const wrapped = function (this: HTMLElement, ...args: unknown[]) {
      const before = el.scrollTop;
      (original as (...a: unknown[]) => void).apply(this, args);
      queueUntagged({
        el,
        before,
        after: el.scrollTop,
        via: `${method}()`,
        stack: shortStack(),
      });
    };
    Object.defineProperty(el, method, {
      configurable: true,
      writable: true,
      value: wrapped,
    });
    restorers.push(() => {
      delete (el as unknown as Record<string, unknown>)[method];
    });
  }
  if (originalScrollIntoView === null && typeof Element !== "undefined") {
    const original = Element.prototype.scrollIntoView;
    if (typeof original === "function") {
      originalScrollIntoView = original;
      Element.prototype.scrollIntoView = function (
        this: Element,
        arg?: boolean | ScrollIntoViewOptions
      ) {
        const owners = [...registrations.values()].filter(r =>
          r.viewport.contains(this)
        );
        const befores = owners.map(r => r.viewport.scrollTop);
        original.call(this, arg);
        owners.forEach((r, i) =>
          queueUntagged({
            el: r.viewport,
            before: befores[i],
            after: r.viewport.scrollTop,
            via: "scrollIntoView()",
            stack: shortStack(),
          })
        );
      };
    }
  }
  return () => {
    for (const restore of restorers) restore();
  };
}

function restoreScrollIntoView(): void {
  if (originalScrollIntoView !== null) {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    originalScrollIntoView = null;
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

function headerDetail(): string {
  if (typeof window === "undefined") return "";
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === "function" &&
      window.matchMedia("(display-mode: standalone)").matches);
  return [
    `version=${getClientVersion() ?? "unknown"}`,
    `viewport=${window.innerWidth}x${window.innerHeight}`,
    `dpr=${window.devicePixelRatio}`,
    `pwa=${standalone ? 1 : 0}`,
    `ua=${navigator.userAgent}`,
  ].join(" ");
}

/** One line per entry, oldest first, after a header. This is what Copy exports. */
export function formatScrollLog(): string {
  const lines = [
    `# hapimatic scroll-cause log (issue #6122) ${headerDetail()}`,
    "# t cause before→after dist sh follow dir pend touch n vp [detail]",
  ];
  for (const e of getScrollLogEntries()) {
    const dist = e.sh - e.after - e.ch;
    const span = e.tEnd !== undefined ? `${e.t}-${e.tEnd}` : `${e.t}`;
    lines.push(
      `${span} ${e.cause} ${e.before}→${e.after} dist=${dist} sh=${e.sh} follow=${e.follow} dir=${e.dir} pend=${e.pend} touch=${e.touch} n=${e.n} vp=${e.vp}${e.detail ? ` ${e.detail}` : ""}`
    );
  }
  return lines.join("\n");
}

function exposeWindowApi(): void {
  if (typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__hapiScrollRec = {
    dump: formatScrollLog,
    entries: getScrollLogEntries,
    clear: clearScrollLog,
  };
}

/** Test-only: forget all registrations and entries. */
export function resetScrollRecorderForTests(): void {
  for (const reg of [...registrations.values()]) {
    registrations.delete(reg.viewport);
  }
  restoreScrollIntoView();
  pendingUntagged = [];
  untaggedFlushScheduled = false;
  clearScrollLog();
  listeners.clear();
}
