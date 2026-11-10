// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import {
  WORKFLOW_PHASES,
  highestCheckpoint,
  labelDisplay,
  labelToPhase,
} from "./workflowPhases";

// Project Manager dashboards (issue #6454, epic #6446): the lane state a Project
// Manager publishes on its `dashboard` pin with `pin_post` / `pin_update`, and the
// stage helpers the Pins tab draws from. Design of record:
// docs/design/pins/design-brief.md (round 1 req 8, rounds 3 to 6) and
// docs/design/pins/pins-mockup-v6.html.
//
// This module imports only zod and the workflow phase map, because `pins.ts`
// imports it to accept `lanes`: importing `pins.ts` back would be a cycle. The
// response shapes that carry a `Pin` live in `pinDashboardApi.ts`.
//
// ## The PM publishes intent, the server owns facts
//
// A lane names its sessions by id or hapi tag. The server joins each session's
// name, model, account, node, status, linked issue, open pins and cost from its
// own record, so none of those are published here. "Waiting on the operator" is a
// server fact (the session has an open pin), never a published flag.
//
// ## No field has a default
//
// `lanes` is optional, and so is every lane field but `letter` and `name`. A
// default would change the canonical JSON of every stored pin, so an identical
// re-post would bump an open dashboard's revision (the `PinContentObjectSchema`
// doc in shared/src/pins.ts).
//
// ## The producer
//
// The `project-manager-role` skill (MattStarfield/rp1-home#3058) publishes this
// contract. If its text and this module ever differ, this module wins.

/**
 * The eight `✅ checkpoint:` stages, in workflow order. A literal tuple because
 * Zod's enum needs one; `pinDashboard.test.ts` keeps it equal to the checkpoint
 * rows of `WORKFLOW_PHASES`.
 *
 * The enum is strict: a ninth checkpoint added later makes an older server refuse
 * the whole dashboard, so the producer publishes only these values.
 */
export const PIN_LANE_STAGES = [
  "created",
  "formatted",
  "researched",
  "expert-reviewed",
  "worked",
  "tested",
  "refactor-reflected",
  "closed",
] as const;
export type PinLaneStage = (typeof PIN_LANE_STAGES)[number];

/** A dashboard's lane count, a lane's session count, and its queue length. */
export const PIN_LANES_MAX = 26;
export const PIN_LANE_SESSIONS_MAX = 8;
export const PIN_LANE_QUEUE_MAX = 100;

const STAGE_SET: ReadonlySet<string> = new Set(PIN_LANE_STAGES);

function stageOfCheckpoint(checkpoint: string): PinLaneStage | null {
  const name = labelDisplay(checkpoint).split(" ").slice(1).join(" ");
  return STAGE_SET.has(name) ? (name as PinLaneStage) : null;
}

type StageRow = { stage: PinLaneStage; order: number; label: string };

const STAGE_ROWS: readonly StageRow[] = WORKFLOW_PHASES.flatMap(phase => {
  if (phase.checkpoint === null) return [];
  const stage = stageOfCheckpoint(phase.checkpoint);
  return stage ? [{ stage, order: phase.order, label: phase.checkpoint }] : [];
});

const STAGE_ORDER: ReadonlyMap<PinLaneStage, number> = new Map(
  STAGE_ROWS.map(row => [row.stage, row.order])
);

/** Each stage's full `✅ checkpoint:` label. */
export const PIN_LANE_STAGE_LABELS: Readonly<Record<PinLaneStage, string>> =
  Object.fromEntries(STAGE_ROWS.map(row => [row.stage, row.label])) as Record<
    PinLaneStage,
    string
  >;

/** Each stage's emoji, the checkpoint label's own (`📝` for researched). */
export const PIN_LANE_STAGE_EMOJI: Readonly<Record<PinLaneStage, string>> =
  Object.fromEntries(
    STAGE_ROWS.map(row => [row.stage, labelDisplay(row.label).split(" ")[0]])
  ) as Record<PinLaneStage, string>;

/** A stage's workflow order (created 1 … closed 9); unknown stages sort first. */
export function stageOrder(stage: PinLaneStage | null | undefined): number {
  return stage ? (STAGE_ORDER.get(stage) ?? 0) : 0;
}

/** The later of two stages; null when both are absent. */
export function laterStage(
  a: PinLaneStage | null | undefined,
  b: PinLaneStage | null | undefined
): PinLaneStage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return stageOrder(b) > stageOrder(a) ? b : a;
}

/**
 * The last finished stage and the stage in progress, from an issue's active
 * workflow labels (the workflow badge, `v_workflow_state`). A held lock is "in
 * progress" only when it is past the last finished checkpoint. The
 * `🔎 pr-reviewing` lock has no checkpoint of its own, so it maps to the next
 * one, `closed`.
 */
export function stageFromLabels(activeLabels: readonly string[]): {
  done: PinLaneStage | null;
  active: PinLaneStage | null;
} {
  const best = highestCheckpoint(activeLabels);
  const done = best ? stageOfCheckpoint(best.label) : null;
  const doneOrder = best?.order ?? 0;
  let lockOrder = 0;
  for (const label of activeLabels) {
    const match = labelToPhase(label);
    if (match?.kind === "lock" && match.order > lockOrder) {
      lockOrder = match.order;
    }
  }
  let active: PinLaneStage | null = null;
  if (lockOrder > doneOrder) {
    active = STAGE_ROWS.find(row => row.order >= lockOrder)?.stage ?? null;
  }
  return { done, active };
}

/**
 * Every stage whose `✅ checkpoint:` label is active, in workflow order: what a
 * stage track needs to tell a skipped `expert-reviewed` (optional) from a
 * finished one.
 */
export function stagesReached(activeLabels: readonly string[]): PinLaneStage[] {
  const reached = new Set<PinLaneStage>();
  for (const label of activeLabels) {
    if (labelToPhase(label)?.kind !== "checkpoint") continue;
    const stage = stageOfCheckpoint(label);
    if (stage) reached.add(stage);
  }
  return PIN_LANE_STAGES.filter(stage => reached.has(stage));
}

const STAGE_SCHEMA = z.enum(PIN_LANE_STAGES);

/** An issue a lane names: `repo` is required because the issue viewer needs it. */
export const PinLaneIssueSchema = z.strictObject({
  number: z.number().int().positive(),
  repo: z
    .string()
    .max(140)
    .regex(
      /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
      'must be "owner/name", such as MattStarfield/hapimatic-private'
    ),
  title: z.string().min(1).max(200).optional(),
  /** The issue's last finished checkpoint, as the PM read it. */
  stage: STAGE_SCHEMA.optional(),
});
export type PinLaneIssue = z.infer<typeof PinLaneIssueSchema>;

export const PinLaneProgressSchema = z
  .strictObject({
    done: z.number().int().nonnegative(),
    total: z.number().int().positive(),
  })
  .refine(p => p.done <= p.total, "done must not be more than total");

/** One session working a lane. */
export const PinLaneSessionSchema = z.strictObject({
  /** The session's id or hapi tag; the server resolves either. */
  session: z.string().min(1).max(200),
  /** The PM's view of the session's current issue (the session's own linked issue wins). */
  issue: PinLaneIssueSchema.optional(),
  /** The last finished checkpoint of the current issue, as the PM read it. */
  stage: STAGE_SCHEMA.optional(),
  task: z.string().min(1).max(200).optional(),
  progress: PinLaneProgressSchema.optional(),
});
export type PinLaneSession = z.infer<typeof PinLaneSessionSchema>;

export const PinLaneSchema = z.strictObject({
  /** A–H have fixed colors in the Pins tab; any other letter draws gold. */
  letter: z.string().regex(/^[A-Z]$/, "must be one capital letter, A to Z"),
  name: z.string().min(1).max(80),
  sessions: z.array(PinLaneSessionSchema).max(PIN_LANE_SESSIONS_MAX).optional(),
  /** The lane's issue when no session runs. */
  issue: PinLaneIssueSchema.optional(),
  /** The issues lined up after the current one, in order. */
  queue: z.array(PinLaneIssueSchema).max(PIN_LANE_QUEUE_MAX).optional(),
});
export type PinLane = z.infer<typeof PinLaneSchema>;

export const PinLanesSchema = z.array(PinLaneSchema).max(PIN_LANES_MAX);

/** Duplicate-letter issues at `lanes.<i>.letter`, for a pin's cross-field rules. */
export function addLaneIssues(
  lanes: readonly { letter: string }[] | undefined,
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  (lanes ?? []).forEach((lane, index) => {
    if (seen.has(lane.letter)) {
      ctx.addIssue({
        code: "custom",
        path: ["lanes", index, "letter"],
        message: `duplicate lane letter "${lane.letter}"`,
      });
    }
    seen.add(lane.letter);
  });
}

/**
 * Lanes read back from a stored dashboard, lane by lane: a lane that does not
 * parse is dropped and `degraded` set, so one bad lane (a newer producer's field,
 * or a record from another build) never hides the rest. A repeated letter keeps
 * its first lane.
 */
export function parseDashboardLanes(raw: unknown): {
  lanes: PinLane[];
  degraded: boolean;
} {
  if (raw === undefined || raw === null) return { lanes: [], degraded: false };
  if (!Array.isArray(raw)) return { lanes: [], degraded: true };
  const lanes: PinLane[] = [];
  const letters = new Set<string>();
  let degraded = raw.length > PIN_LANES_MAX;
  for (const item of raw.slice(0, PIN_LANES_MAX)) {
    const parsed = PinLaneSchema.safeParse(item);
    if (!parsed.success || letters.has(parsed.data.letter)) {
      degraded = true;
      continue;
    }
    letters.add(parsed.data.letter);
    lanes.push(parsed.data);
  }
  return { lanes, degraded };
}

/** Every session ref a set of lanes names, in lane order, without repeats. */
export function laneSessionRefs(lanes: readonly PinLane[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const lane of lanes) {
    for (const entry of lane.sessions ?? []) {
      if (!seen.has(entry.session)) {
        seen.add(entry.session);
        refs.push(entry.session);
      }
    }
  }
  return refs;
}
