// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState, type JSX } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import {
  BRIDGE_DURATION_MS,
  BRIDGE_TIMING,
  PULSE_LAYERS,
  RECEIVER_DOT_X,
  RIPPLES,
  RIPPLE_CENTER,
  RIPPLE_START_OPACITY,
  RIPPLE_START_R,
  RIPPLE_STROKE_WIDTH,
  ROUTE_D,
  ROUTE_OPACITY,
  ROUTE_WIDTH,
  SENDER_DOT_X,
  WORDMARK_GLYPHS,
  WORDMARK_I_DOT_D,
  WORDMARK_MINT,
  WORDMARK_VIEWBOX,
  WORDMARK_VIOLET,
  WORDMARK_WHITE,
} from "./wordmarkGeometry";

/**
 * When the last bridge started (performance.now() ms), for this page lifetime.
 *
 * Module scope on purpose (#4776): App.tsx swaps its pre-auth <BrandedFrame>
 * for the logged-in shell's, and thread full-screen (#3638) empties the
 * header, so the wordmark remounts — usually while the 1.7 s bridge is still
 * running. Component state would restart the bridge on every remount; this
 * latch lets a remount continue the bridge, or hold the T2 frame once it ended.
 */
let lastBridgeStartedAt: number | null = null;

/**
 * Decide what a freshly mounted wordmark shows. The first mount of the page
 * lifetime plays from the start; a mount while a bridge is still running
 * continues it from the elapsed offset; any later mount holds the T2 frame.
 *
 * Before the window `load` event a mount always plays from the start: Chromium
 * holds the SMIL clock of an <svg> inserted before `load` at 0 until `load`, so
 * nothing has been seen yet and the latch (mount time) is only provisional.
 */
export function decideMountPlayback(
  now: number,
  startedAt: number | null,
  documentLoaded = true
): { play: boolean; seekMs: number } {
  if (startedAt === null || !documentLoaded) return { play: true, seekMs: 0 };
  const elapsed = now - startedAt;
  if (elapsed < BRIDGE_DURATION_MS) {
    return { play: true, seekMs: Math.max(0, elapsed) };
  }
  return { play: false, seekMs: 0 };
}

function documentLoaded(): boolean {
  return typeof document === "undefined" || document.readyState === "complete";
}

/** Test-only: forget the launch, as a fresh page load would. */
export function __resetWordmarkPlaybackForTests(): void {
  lastBridgeStartedAt = null;
}

export interface HapimaticWordmarkProps {
  /**
   * Bump to replay the bridge from its first frame (each tap of the wordmark).
   * Its value at mount is the baseline, so remounting never counts as a tap.
   */
  replayToken?: number;
  /** Size classes for the <svg>; the width follows from the viewBox. */
  className?: string;
}

const seconds = (s: number): string => `${s}s`;

function IDot(props: { x: number; fill: string; children?: JSX.Element }) {
  return (
    <path
      transform={`translate(${props.x})`}
      d={WORDMARK_I_DOT_D}
      fill={props.fill}
    >
      {props.children}
    </path>
  );
}

function Letters() {
  return (
    <g fill={WORDMARK_WHITE}>
      {WORDMARK_GLYPHS.map(glyph => (
        <path key={glyph.x} transform={`translate(${glyph.x})`} d={glyph.d} />
      ))}
    </g>
  );
}

/** The held T2 ("transmission") frame — also the reduced-motion rendering. */
function TransmissionFrame() {
  return (
    <>
      <path
        d={ROUTE_D}
        fill="none"
        stroke={WORDMARK_VIOLET}
        strokeWidth={ROUTE_WIDTH}
        strokeLinecap="round"
        opacity={ROUTE_OPACITY}
      />
      {RIPPLES.map(ripple => (
        <circle
          key={ripple.r}
          cx={RIPPLE_CENTER.cx}
          cy={RIPPLE_CENTER.cy}
          r={ripple.r}
          fill="none"
          stroke={WORDMARK_MINT}
          strokeWidth={RIPPLE_STROKE_WIDTH}
          opacity={ripple.opacity}
        />
      ))}
      {PULSE_LAYERS.map(layer => (
        <path
          key={layer.dash}
          d={layer.stillD}
          fill="none"
          stroke={WORDMARK_MINT}
          strokeWidth={layer.width}
          strokeLinecap="round"
          opacity={layer.opacity}
        />
      ))}
      <IDot x={SENDER_DOT_X} fill={WORDMARK_MINT} />
      <IDot x={RECEIVER_DOT_X} fill={WORDMARK_MINT} />
    </>
  );
}

/**
 * The bridge: from the at-rest mark (both dots white, nothing else drawn) to
 * the T2 frame, once. Every animation freezes on its last value, so after
 * BRIDGE_DURATION_MS the drawing equals TransmissionFrame and nothing moves.
 */
function Bridge() {
  const { route, ripple, pulse, senderDot, receiverDot } = BRIDGE_TIMING;
  return (
    <>
      <path
        d={ROUTE_D}
        pathLength={100}
        fill="none"
        stroke={WORDMARK_VIOLET}
        strokeWidth={ROUTE_WIDTH}
        strokeLinecap="round"
        strokeDasharray="100 100"
        strokeDashoffset={100}
        opacity={0}
      >
        <set
          attributeName="opacity"
          to={String(ROUTE_OPACITY)}
          begin={seconds(route.begin)}
          fill="freeze"
        />
        <animate
          attributeName="stroke-dashoffset"
          from="100"
          to="0"
          begin={seconds(route.begin)}
          dur={seconds(route.dur)}
          fill="freeze"
          calcMode="spline"
          keyTimes="0;1"
          keySplines={route.keySplines}
        />
      </path>
      {RIPPLES.map(ring => (
        <circle
          key={ring.r}
          cx={RIPPLE_CENTER.cx}
          cy={RIPPLE_CENTER.cy}
          r={RIPPLE_START_R}
          fill="none"
          stroke={WORDMARK_MINT}
          strokeWidth={RIPPLE_STROKE_WIDTH}
          opacity={0}
        >
          <animate
            attributeName="r"
            from={RIPPLE_START_R}
            to={ring.r}
            begin={seconds(ring.begin)}
            dur={seconds(ripple.dur)}
            fill="freeze"
            calcMode="spline"
            keyTimes="0;1"
            keySplines={ripple.keySplines}
          />
          <animate
            attributeName="opacity"
            from={RIPPLE_START_OPACITY}
            to={ring.opacity}
            begin={seconds(ring.begin)}
            dur={seconds(ripple.dur)}
            fill="freeze"
          />
        </circle>
      ))}
      {PULSE_LAYERS.map(layer => (
        <path
          key={layer.dash}
          d={ROUTE_D}
          pathLength={100}
          fill="none"
          stroke={WORDMARK_MINT}
          strokeWidth={layer.width}
          strokeLinecap="round"
          strokeDasharray={`${layer.dash} 400`}
          strokeDashoffset={layer.fromOffset}
          opacity={0}
        >
          <set
            attributeName="opacity"
            to={String(layer.opacity)}
            begin={seconds(pulse.begin)}
            fill="freeze"
          />
          <animate
            attributeName="stroke-dashoffset"
            from={layer.fromOffset}
            to={layer.toOffset}
            begin={seconds(pulse.begin)}
            dur={seconds(pulse.dur)}
            fill="freeze"
            calcMode="spline"
            keyTimes="0;1"
            keySplines={pulse.keySplines}
          />
        </path>
      ))}
      <IDot x={SENDER_DOT_X} fill={WORDMARK_WHITE}>
        <animate
          attributeName="fill"
          from={WORDMARK_WHITE}
          to={WORDMARK_MINT}
          begin={seconds(senderDot.begin)}
          dur={seconds(senderDot.dur)}
          fill="freeze"
        />
      </IDot>
      <IDot x={RECEIVER_DOT_X} fill={WORDMARK_WHITE}>
        <animate
          attributeName="fill"
          from={WORDMARK_WHITE}
          to={WORDMARK_MINT}
          begin={seconds(receiverDot.begin)}
          dur={seconds(receiverDot.dur)}
          fill="freeze"
        />
      </IDot>
    </>
  );
}

/**
 * The Hapimatic title-bar wordmark (#4776): the W11 outlines that play the
 * transmission "bridge" once per page load and on each tap, then hold the T2
 * frame. With reduced motion it renders the T2 frame and no SMIL at all.
 *
 * This is the default mark behind the per-instance wordmark slot (#2119); it
 * owns no navigation — the caller wraps it in its home link.
 */
export function HapimaticWordmark({
  replayToken = 0,
  className = "h-7",
}: HapimaticWordmarkProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Decided once per mount. The latch is only READ here; it is written in the
  // layout effect below, because StrictMode double-invokes this initializer.
  const [mount] = useState(() => {
    const now = performance.now();
    return {
      now,
      ...decideMountPlayback(now, lastBridgeStartedAt, documentLoaded()),
    };
  });
  const [playback, setPlayback] = useState({
    play: mount.play,
    key: 0,
    seekMs: mount.seekMs,
  });
  const [seenToken, setSeenToken] = useState(replayToken);
  const svgRef = useRef<SVGSVGElement>(null);

  // A tap (new replayToken) replays from the first frame — unless motion is
  // reduced, where the T2 frame simply stays. Adjusting state during render is
  // React's documented pattern for responding to a prop change.
  if (replayToken !== seenToken) {
    setSeenToken(replayToken);
    if (!reducedMotion) {
      setPlayback(p => ({ play: true, key: p.key + 1, seekMs: 0 }));
    }
  }
  // Reduced motion switched on mid-bridge: drop to the T2 frame for good, so
  // switching it off again does not restart the bridge (only a tap does).
  if (reducedMotion && playback.play) {
    setPlayback(p => ({ ...p, play: false }));
  }

  const showBridge = playback.play && !reducedMotion;

  useLayoutEffect(() => {
    if (!showBridge) {
      // Launch with reduced motion: still record the launch, so a later mount
      // does not mistake itself for the first one.
      if (lastBridgeStartedAt === null) lastBridgeStartedAt = mount.now;
      return;
    }
    // A bridge <svg> was just inserted (its SMIL clock starts at 0). Seek it
    // before paint: 0 for a fresh play, the elapsed time when continuing a
    // bridge across a remount. jsdom has no SMIL API, hence the guards.
    const svg = svgRef.current;
    if (svg && typeof svg.setCurrentTime === "function") {
      svg.setCurrentTime(playback.seekMs / 1000);
      if (typeof svg.unpauseAnimations === "function") {
        svg.unpauseAnimations();
      }
    }
    lastBridgeStartedAt = performance.now() - playback.seekMs;
    if (documentLoaded()) return;
    // Mounted before `load`: the clock may not run until then (Chromium holds
    // it at 0). Re-anchor the latch at `load` from the bridge's own clock, so
    // it is right whichever moment an engine starts the clock.
    const reanchor = () => {
      const clock =
        svg && typeof svg.getCurrentTime === "function"
          ? svg.getCurrentTime()
          : 0;
      lastBridgeStartedAt = performance.now() - clock * 1000;
    };
    window.addEventListener("load", reanchor, { once: true });
    return () => window.removeEventListener("load", reanchor);
  }, [showBridge, playback.key, playback.seekMs, mount.now]);

  const shared = {
    viewBox: WORDMARK_VIEWBOX,
    role: "img",
    "aria-label": "Hapimatic",
    className,
  } as const;

  // The key sits on the <svg> itself: only a NEW <svg> gets a new SMIL clock,
  // so re-keying an inner group would not replay anything.
  return showBridge ? (
    <svg
      key={`bridge-${playback.key}`}
      ref={svgRef}
      {...shared}
      data-wordmark="bridge"
    >
      <Letters />
      <Bridge />
    </svg>
  ) : (
    <svg key="still" {...shared} data-wordmark="still">
      <Letters />
      <TransmissionFrame />
    </svg>
  );
}
