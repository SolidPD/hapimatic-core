// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { vi, type Mock } from "vitest";
import type { Pin, PinAnswer } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import {
  PinsContext,
  type PinsContextValue,
} from "@/components/pins/pinsShared";
import { createMockApiClient, createQueryWrapper } from "@/test/test-utils";

/** #6449: a pin record as A's routes return it, with test overrides. */
export function makePin(
  over: Partial<Pin> & Record<string, unknown> = {}
): Pin {
  return {
    key: "k1",
    kind: "decision",
    title: "Ship the release?",
    plainText: "Ship the release?\nA. Ship\nB. Wait",
    stakes: "reversible",
    risk: "low",
    blocking: false,
    sessionId: "s1",
    sourceSessionId: "s1",
    revision: 1,
    status: "open",
    starred: false,
    seenAt: null,
    seenRevision: null,
    postedSeq: null,
    anchor: null,
    answers: [],
    createdAt: "2026-11-07T20:00:00.000Z",
    updatedAt: "2026-11-07T20:00:00.000Z",
    ...over,
  } as Pin;
}

export function makeAnswer(over: Partial<PinAnswer> = {}): PinAnswer {
  return {
    revision: 1,
    at: "2026-11-07T21:00:00.000Z",
    by: "operator",
    via: "pins",
    resolves: true,
    moot: false,
    ...over,
  };
}

/** A query client plus the Pins context, for rendering one Pins component. */
export function pinsWrapper(
  opts: {
    sessionActive?: boolean;
    via?: "pins" | "chat";
    timeZone?: string;
  } = {}
): {
  wrapper: (props: { children: ReactNode }) => ReactNode;
  api: Record<string, Mock>;
  markSeen: Mock;
  queryClient: QueryClient;
} {
  const api = createMockApiClient();
  const markSeen = vi.fn();
  const { wrapper: QueryWrapper, queryClient } = createQueryWrapper({
    gcTime: Infinity,
  });
  const value: PinsContextValue = {
    api: api as unknown as ApiClient,
    sessionId: "s1",
    sessionActive: opts.sessionActive ?? true,
    markSeen,
    via: opts.via ?? "pins",
    timeZone: opts.timeZone ?? "America/New_York",
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryWrapper>
      <PinsContext.Provider value={value}>{children}</PinsContext.Provider>
    </QueryWrapper>
  );
  return { wrapper, api, markSeen, queryClient };
}

/**
 * #6454: a `GET /api/pins/dashboards` answer: two Project Managers on RP1. The
 * first ("Pins PM") spawned `s1` and runs lanes A (session `lane-a`, with an
 * open pin), B (session `lane-b` by tag, working with progress), and C (no
 * session, three queued issues); the second ("Docs PM") runs one idle lane.
 */
export function makeDashboardsResponse(
  over: { managing?: string; secondUpdatedAt?: string } = {}
) {
  const repo = "MattStarfield/hapimatic-private";
  const dashboard = (
    sessionId: string,
    lanes: unknown[],
    refs: Record<string, string>,
    updatedAt = "2026-11-08T10:00:00.000Z"
  ) => ({
    sessionId,
    nodeId: "rp1",
    nodeLabel: "RP1",
    refs,
    unresolved: [],
    pin: makePin({
      key: "pm-dashboard",
      kind: "dashboard",
      status: "live",
      title: `${sessionId} dashboard`,
      sessionId,
      sourceSessionId: sessionId,
      updatedAt,
      lanes: lanes as Pin["lanes"],
    }),
  });
  return {
    dashboards: [
      dashboard(
        "docs-pm",
        [{ letter: "A", name: "Docs", sessions: [{ session: "docs-lane" }] }],
        { "docs-lane": "docs-lane" },
        over.secondUpdatedAt ?? "2026-11-08T12:00:00.000Z"
      ),
      dashboard(
        over.managing ?? "pins-pm",
        [
          {
            letter: "A",
            name: "Server",
            sessions: [{ session: "lane-a", task: "Wire the receiver" }],
          },
          {
            letter: "B",
            name: "Web",
            sessions: [
              {
                session: "lane-b-tag",
                task: "Build the lane box",
                progress: { done: 3, total: 8 },
              },
            ],
          },
          {
            letter: "C",
            name: "Docs follow-up",
            issue: { number: 6460, repo, stage: "researched" },
            queue: [
              { number: 6461, repo, title: "One" },
              { number: 6462, repo, title: "Two" },
              { number: 6463, repo, title: "Three", stage: "formatted" },
            ],
          },
        ],
        { "lane-a": "lane-a", "lane-b-tag": "lane-b" }
      ),
    ],
    sessions: {
      "pins-pm": {
        id: "pins-pm",
        name: "Pins PM",
        active: true,
        nodeId: "rp1",
        nodeLabel: "RP1",
      },
      "docs-pm": {
        id: "docs-pm",
        name: "Docs PM",
        active: true,
        nodeId: "rp1",
        nodeLabel: "RP1",
      },
      "lane-a": {
        id: "lane-a",
        name: "Lane A worker",
        model: "claude-opus-4-8",
        active: true,
        thinking: false,
        openPinCount: 1,
        nodeId: "rp1",
        nodeLabel: "RP1",
        linkedIssue: { number: 6454, title: "Pins H", repo },
        badge: {
          repo,
          number: 6454,
          done: "researched",
          active: "worked",
          reached: ["created", "formatted", "researched"],
        },
        createdAt: Date.parse("2026-11-08T09:00:00.000Z"),
        activeAt: Date.parse("2026-11-08T09:55:00.000Z"),
        totals: { cost: 1.5, tokens: 12000 },
      },
      "lane-b": {
        id: "lane-b",
        tag: "lane-b-tag",
        name: "Lane B worker",
        active: true,
        thinking: true,
        openPinCount: 0,
        nodeId: "rp1",
        nodeLabel: "RP1",
      },
      "docs-lane": {
        id: "docs-lane",
        name: "Docs worker",
        active: true,
        openPinCount: 0,
      },
    },
    nodes: [],
    partial: false,
  };
}
