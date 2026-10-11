// SPDX-License-Identifier: MIT
import { z } from "zod";

export const ClaudePtyOutputPayloadSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

export type ClaudePtyOutputPayload = z.infer<
  typeof ClaudePtyOutputPayloadSchema
>;

export const ClaudePtyWritePayloadSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

export type ClaudePtyWritePayload = z.infer<typeof ClaudePtyWritePayloadSchema>;

export const ClaudePtyResizePayloadSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export type ClaudePtyResizePayload = z.infer<
  typeof ClaudePtyResizePayloadSchema
>;
