// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { PinSchema } from "./pins";

// `GET /api/pins/dashboards` and its peer receiver (issue #6454, epic #6446): every
// Project Manager dashboard in the caller's namespace, with the server's facts for
// each session it names. Loose on purpose (shared/src/pins.ts header): a newer
// peer's added field must survive an older hub and an older web client.

/** A session's facts as the server knows them, joined over a dashboard's lane refs. */
export const PinDashboardSessionFactsSchema = z
  .object({
    id: z.string(),
    tag: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    emoji: z.string().nullable().optional(),
    active: z.boolean().optional(),
    thinking: z.boolean().optional(),
    model: z.string().nullable().optional(),
    accountEmail: z.string().nullable().optional(),
    nodeId: z.string().nullable().optional(),
    nodeLabel: z.string().nullable().optional(),
    linkedIssue: z
      .object({
        number: z.number(),
        title: z.string().optional(),
        repo: z.string(),
        state: z.string().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    /** The workflow badge of the linked issue: its repo, number, and stages. */
    badge: z
      .object({
        repo: z.string().nullable(),
        number: z.number(),
        done: z.string().nullable(),
        active: z.string().nullable(),
        /** Every checkpoint stage reached, in order (an older node omits it). */
        reached: z.array(z.string()).optional(),
      })
      .loose()
      .nullable()
      .optional(),
    /** Absent when the session's node cannot serve pins: unknown, not zero. */
    openPinCount: z.number().int().nonnegative().optional(),
    createdAt: z.number().nullable().optional(),
    activeAt: z.number().nullable().optional(),
    parentSessionId: z.string().nullable().optional(),
    parentRelationship: z.string().nullable().optional(),
    /** Only from the node that owns the session's turns. */
    totals: z
      .object({ cost: z.number().nullable(), tokens: z.number().nullable() })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();
export type PinDashboardSessionFacts = z.infer<
  typeof PinDashboardSessionFactsSchema
>;

/** One Project Manager's dashboard pin and how its lane refs resolved. */
export const PinDashboardSchema = z
  .object({
    pin: PinSchema,
    /** The PM's session id. */
    sessionId: z.string(),
    nodeId: z.string().nullable().optional(),
    nodeLabel: z.string().nullable().optional(),
    /** A lane's session ref (an id or a tag) → the session id it resolved to. */
    refs: z.record(z.string(), z.string()),
    /** Refs this node could not resolve (a session on another node). */
    unresolved: z.array(z.string()),
  })
  .loose();
export type PinDashboard = z.infer<typeof PinDashboardSchema>;

/** One node's answer: its own dashboards and the facts it could join. */
export const PinDashboardsNodeResultSchema = z
  .object({
    dashboards: z.array(PinDashboardSchema),
    sessions: z.record(z.string(), PinDashboardSessionFactsSchema),
  })
  .loose();
export type PinDashboardsNodeResult = z.infer<
  typeof PinDashboardsNodeResultSchema
>;

/**
 * `answered`, `unsupported` (an older peer or a closed Pins gate), `failed`, or
 * `offline` (listed, not asked). Only `failed` makes an answer partial.
 */
export const PinDashboardNodeStatusSchema = z
  .object({
    nodeId: z.string(),
    nodeLabel: z.string().optional(),
    status: z.string(),
    error: z.string().optional(),
  })
  .loose();
export type PinDashboardNodeStatus = z.infer<
  typeof PinDashboardNodeStatusSchema
>;

/** `GET /api/pins/dashboards`. `partial`: a node that should have answered did not. */
export const PinDashboardsResponseSchema = z
  .object({
    dashboards: z.array(PinDashboardSchema),
    sessions: z.record(z.string(), PinDashboardSessionFactsSchema),
    nodes: z.array(PinDashboardNodeStatusSchema),
    partial: z.boolean(),
  })
  .loose();
export type PinDashboardsResponse = z.infer<typeof PinDashboardsResponseSchema>;
