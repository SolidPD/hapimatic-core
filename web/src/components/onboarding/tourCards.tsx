// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement, ReactNode } from "react";
import type { OnboardingStepId } from "@hapi/protocol/schemas";

/**
 * The T1–T5 cards of the in-app first-run feature tour (#3865, UX_SPEC §3).
 *
 * Passive (OQ-3): each card illustrates a real surface and drives nothing — no
 * links, no live controls, nothing that can mutate state by accident.
 *
 * Illustrations are inline schematics coloured with design tokens only
 * (`var(--app-*)`, `var(--status-*)`), never a raster screenshot: a screenshot
 * goes stale with the UI, ignores the theme, and can carry real project names
 * and account e-mails into a shipped product. They are decorative
 * (`aria-hidden`); the card text carries the meaning.
 *
 * T5 (v1) names only surfaces that exist today — provider API keys and
 * model-subscription accounts, both under Settings → Provider Accounts (#4906).
 * The connector checklist (spec §4) is v2 and waits on epic #2716.
 */
export interface TourCard {
  id: OnboardingStepId;
  title: string;
  body: string;
  Illustration: () => ReactElement;
}

const SVG_CLASS = "h-auto w-full max-w-xs";
const PANEL =
  "fill-[var(--app-bg)] stroke-[var(--app-border)] [stroke-width:1.5]";
const SURFACE = "fill-[var(--app-subtle-bg)]";
const LINE = "fill-[var(--app-hint)]";
const STRONG = "fill-[var(--app-fg)]";

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 240 150"
      className={SVG_CLASS}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="6" y="6" width="228" height="138" rx="12" className={PANEL} />
      {children}
    </svg>
  );
}

function SessionsIllustration() {
  const rows = [
    { y: 46, dot: "fill-[var(--status-cat-working)]" },
    { y: 76, dot: "fill-[var(--status-cat-active)]" },
    { y: 106, dot: "fill-[var(--status-cat-inactive)]" },
  ];
  return (
    <Frame>
      <rect x="20" y="20" width="64" height="8" rx="4" className={STRONG} />
      <circle
        cx="210"
        cy="24"
        r="10"
        className="fill-none stroke-[var(--app-accent)] [stroke-width:2]"
      />
      <path
        d="M205 24h10M210 19v10"
        className="stroke-[var(--app-fg)] [stroke-width:2] [stroke-linecap:round]"
      />
      {rows.map(row => (
        <g key={row.y}>
          <rect
            x="18"
            y={row.y}
            width="204"
            height="24"
            rx="6"
            className={SURFACE}
          />
          <circle cx="32" cy={row.y + 12} r="4" className={row.dot} />
          <rect
            x="44"
            y={row.y + 6}
            width="96"
            height="5"
            rx="2.5"
            className={STRONG}
          />
          <rect
            x="44"
            y={row.y + 14}
            width="64"
            height="4"
            rx="2"
            className={LINE}
          />
        </g>
      ))}
    </Frame>
  );
}

function CreateIllustration() {
  const fields = [22, 46, 70, 94];
  return (
    <Frame>
      {fields.map(y => (
        <g key={y}>
          <rect
            x="20"
            y={y + 5}
            width="44"
            height="5"
            rx="2.5"
            className={LINE}
          />
          <rect
            x="74"
            y={y}
            width="146"
            height="16"
            rx="5"
            className="fill-[var(--app-subtle-bg)] stroke-[var(--app-border)]"
          />
          <rect
            x="82"
            y={y + 6}
            width="70"
            height="4"
            rx="2"
            className={STRONG}
          />
        </g>
      ))}
      <rect
        x="150"
        y="118"
        width="70"
        height="16"
        rx="8"
        className="fill-[var(--app-accent)]"
      />
    </Frame>
  );
}

function SessionIllustration() {
  const tabs = [20, 68, 116, 164];
  return (
    <Frame>
      {tabs.map((x, i) => (
        <rect
          key={x}
          x={x}
          y="18"
          width="44"
          height="14"
          rx="5"
          className={
            i === 0
              ? "fill-[var(--app-subtle-bg)] stroke-[var(--app-accent)]"
              : "fill-none stroke-[var(--app-border)]"
          }
        />
      ))}
      <rect x="112" y="46" width="108" height="22" rx="8" className={SURFACE} />
      <rect x="120" y="54" width="72" height="5" rx="2.5" className={STRONG} />
      <rect x="20" y="78" width="140" height="5" rx="2.5" className={STRONG} />
      <rect x="20" y="90" width="176" height="4" rx="2" className={LINE} />
      <rect x="20" y="100" width="150" height="4" rx="2" className={LINE} />
      <rect
        x="20"
        y="118"
        width="200"
        height="16"
        rx="8"
        className="fill-none stroke-[var(--app-border)]"
      />
    </Frame>
  );
}

function UsageIllustration() {
  const bars = [
    { y: 50, fill: 52, tone: "fill-[var(--status-ok)]" },
    { y: 78, fill: 96, tone: "fill-[var(--status-ok)]" },
    { y: 106, fill: 128, tone: "fill-[var(--status-warn)]" },
  ];
  return (
    <Frame>
      <rect x="20" y="22" width="96" height="7" rx="3.5" className={STRONG} />
      {bars.map(bar => (
        <g key={bar.y}>
          <rect
            x="20"
            y={bar.y}
            width="40"
            height="5"
            rx="2.5"
            className={LINE}
          />
          <rect
            x="20"
            y={bar.y + 10}
            width="160"
            height="8"
            rx="4"
            className={SURFACE}
          />
          <rect
            x="20"
            y={bar.y + 10}
            width={bar.fill}
            height="8"
            rx="4"
            className={bar.tone}
          />
          <rect
            x="190"
            y={bar.y + 11}
            width="30"
            height="5"
            rx="2.5"
            className={LINE}
          />
        </g>
      ))}
    </Frame>
  );
}

function ConnectIllustration() {
  const rows = [36, 74];
  return (
    <Frame>
      {rows.map((y, i) => (
        <g key={y}>
          <rect
            x="18"
            y={y}
            width="204"
            height="28"
            rx="7"
            className={SURFACE}
          />
          {i === 0 ? (
            <g className="fill-none stroke-[var(--app-fg)] [stroke-width:1.75] [stroke-linecap:round]">
              <circle cx="33" cy={y + 14} r="5" />
              <path d={`M38 ${y + 14}h12M46 ${y + 14}v4M49 ${y + 14}v3`} />
            </g>
          ) : (
            <path
              d="M38 84a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0"
              className="fill-none stroke-[var(--app-fg)] [stroke-width:1.75] [stroke-linecap:round]"
            />
          )}
          <rect
            x="56"
            y={y + 9}
            width="96"
            height="5"
            rx="2.5"
            className={STRONG}
          />
          <rect
            x="56"
            y={y + 17}
            width="62"
            height="4"
            rx="2"
            className={LINE}
          />
          <circle
            cx="206"
            cy={y + 14}
            r="6"
            className="fill-none stroke-[var(--app-hint)] [stroke-width:1.5]"
          />
        </g>
      ))}
      <rect
        x="70"
        y="116"
        width="100"
        height="16"
        rx="8"
        className="fill-none stroke-[var(--app-border)] [stroke-dasharray:4_3]"
      />
    </Frame>
  );
}

export const TOUR_CARDS: readonly TourCard[] = [
  {
    id: "t1",
    title: "Sessions live here",
    body: "Every coding session is a row in this list. Tap + at the top to start a new one.",
    Illustration: SessionsIllustration,
  },
  {
    id: "t2",
    title: "Start a session",
    body: "Pick a repo, harness, model, and permission mode — sensible defaults are pre-filled.",
    Illustration: CreateIllustration,
  },
  {
    id: "t3",
    title: "Work in the session",
    body: "Chat with the agent, and switch views for its terminal and files — and, on a cloud machine, its desktop.",
    Illustration: SessionIllustration,
  },
  {
    id: "t4",
    title: "Watch your usage",
    body: "Settings → Provider Accounts shows each account's 5-hour and weekly budgets, including per-model limits such as Fable, and when each one resets.",
    Illustration: UsageIllustration,
  },
  {
    id: "t5",
    title: "Connect your services (optional)",
    body: "Sign in to your model subscriptions and add model-provider API keys under Settings → Provider Accounts — or skip this and do it later. Questions any time: Settings → Help.",
    Illustration: ConnectIllustration,
  },
];

/** Index of a step ID in the tour; an unknown ID starts at the first card. */
export function tourIndexOf(step: OnboardingStepId): number {
  const index = TOUR_CARDS.findIndex(card => card.id === step);
  return index === -1 ? 0 : index;
}
