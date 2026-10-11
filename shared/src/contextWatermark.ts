// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Skill-revamp 3.4 (#2158, epic rp1-home#1319) — the context-watermark
// successor-handoff protocol. When an orchestrator (`pm`-role) session's context
// usage crosses a watermark, the server arms it; at the next clean turn-finalize
// boundary it hands the initiative off to a fresh successor and winds the
// predecessor down. This module is the SHARED contract: the handoff packet the
// successor consumes and the observable watermark state machine.
//
// Every object schema is `.passthrough()` per the shared/CLAUDE.md forked-upstream
// rule; timestamps are epoch-ms numbers throughout (parity with initiatives.ts /
// fileClaims.ts / the pm_spawn_roster precedent).

/**
 * One pending gate the successor must still service (a workflow checkpoint gate,
 * an awaiting-approval sentinel, a review it owes). `ref` is opaque to the server
 * — it is meaningful only to the PM that reads the packet.
 */
export const HandoffPendingGateSchema = z
  .object({
    kind: z.string(),
    ref: z.string(),
    note: z.string().optional(),
  })
  .passthrough();
export type HandoffPendingGate = z.infer<typeof HandoffPendingGateSchema>;

/**
 * The structured handoff packet (R4). 🔴 The packet MUST be sufficient on its
 * own: a successor resumes from THIS alone, never by reading the predecessor's
 * transcript. If a field would require a transcript read to reconstruct, it
 * belongs IN the packet.
 *
 * `checkpointPath` is **nullable**: it points at a predecessor-authored
 * RESILIENCE.md-style markdown checkpoint WHEN ONE EXISTS. The server cannot
 * author that narrative — the packet itself (this JSON envelope) is the
 * machine-readable handoff artifact; the checkpoint is a separate, optional,
 * human/agent-authored companion. Do not conflate the two.
 *
 * `generation` is the anti-chain counter: 0 for an original session, the
 * predecessor's `generation + 1` for each successor. It is hard-capped by the
 * config's `maxHandoffGeneration` so a runaway handoff chain alerts instead of
 * arming.
 */
export const HandoffPacketSchema = z
  .object({
    version: z.literal(1),
    predecessorSessionId: z.string(),
    successorSessionId: z.string().nullable(),
    initiativeId: z.string().nullable(),
    phase: z.string().nullable(),
    pendingGates: z.array(HandoffPendingGateSchema),
    checkpointPath: z.string().nullable(),
    contextPercentageAtHandoff: z.number(),
    createdAtMs: z.number(), // epoch ms
    generation: z.number().int().min(0),
  })
  .passthrough();
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

/**
 * The observable handoff state machine for one session (drives R2/R6/R7 tests and
 * the `GET /api/watermark` route):
 *   idle → armed → handing_off → complete | failed
 *
 * `handing_off` and `suppressed` are PERSISTED (the watermark store): `handing_off`
 * holds predecessor input for the detached pipeline's duration (a restart that
 * forgot it would reopen the reap race); `suppressed` is the disarm hysteresis
 * flag (a restart that forgot it would re-arm a manually-disarmed session within
 * one poll).
 */
export const HandoffStateSchema = z.enum([
  "idle",
  "armed",
  "handing_off",
  "complete",
  "failed",
]);
export type HandoffState = z.infer<typeof HandoffStateSchema>;

export const WatermarkDeferReasonSchema = z.enum([
  "mid_transaction",
  "capacity",
  "disabled",
]);
export type WatermarkDeferReason = z.infer<typeof WatermarkDeferReasonSchema>;

export const WatermarkStateSchema = z
  .object({
    sessionId: z.string(),
    armed: z.boolean(),
    armedAtMs: z.number().nullable(),
    contextPercentage: z.number(),
    deferredReason: WatermarkDeferReasonSchema.nullable(),
    handoffState: HandoffStateSchema,
    /** The inherited packet generation (anti-chain cap source). 0 for originals. */
    generation: z.number().int().min(0),
    suppressed: z.boolean(),
  })
  .passthrough();
export type WatermarkState = z.infer<typeof WatermarkStateSchema>;

/** GET /api/watermark — the per-session state list (observability, R5). */
export const WatermarkStatusResponseSchema = z
  .object({
    enabled: z.boolean(),
    states: z.array(WatermarkStateSchema),
  })
  .passthrough();
export type WatermarkStatusResponse = z.infer<
  typeof WatermarkStatusResponseSchema
>;

/**
 * Render the handoff packet as the successor's FIRST message. Kept in the shared
 * package so the server (producer) and the `project-manager-role` skill (consumer,
 * rp1-home companion) agree on one wire format. The body is self-contained: the
 * JSON packet plus, when present, the checkpoint path the successor should read
 * for the predecessor-authored narrative. It deliberately contains NO instruction
 * to "read the previous session" — the packet is sufficient on its own (R4).
 */
export function renderHandoffMessage(packet: HandoffPacket): string {
  const lines = [
    "[CONTEXT-WATERMARK HANDOFF] You are the successor session. Resume this",
    "initiative from the structured packet below — do NOT read the predecessor's",
    "transcript; everything you need is in the packet.",
    "",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
  ];
  if (packet.checkpointPath) {
    lines.push(
      "",
      `A predecessor-authored checkpoint is available at: ${packet.checkpointPath}`,
      "Read it for the narrative context that the machine-readable packet omits."
    );
  }
  return lines.join("\n");
}
