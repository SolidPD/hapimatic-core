// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { RpcRegistry } from "../../rpcRegistry";
import type { SocketWithData } from "../../socketTypes";

/**
 * Runtime guard for the optional `meta` field carried on `rpc-register`
 * (issue #2417). This zod schema IS the server-side source of truth for the
 * CapabilityMeta shape — `CapabilityMeta` below is inferred from it, so there
 * is no hand-mirrored type to drift from the guard (KD-2). The server treats
 * the JSON Schemas inside `meta` as opaque validated JSON; only the CLI derives
 * them from zod via `z.toJSONSchema()`.
 *
 * `z.record(keyType, valueType)` uses the zod v4 two-arg form (server is on
 * `zod ^4.2.1`, matching cli/shared — OR-1 resolved).
 */
export const capabilityMetaSchema = z.object({
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  riskTier: z.enum(["readonly", "mutating", "destructive"]),
  since: z.string(),
});

/** Server-side CapabilityMeta type, inferred from the runtime guard (KD-2). */
export type CapabilityMeta = z.infer<typeof capabilityMetaSchema>;

const rpcRegisterSchema = z.object({
  method: z.string().min(1),
  // Load-bearing `.optional()`: a bare `{ method }` payload from an old client
  // MUST still parse (R2/R4 — mixed-version fleet degrades to name-only).
  meta: capabilityMetaSchema.optional(),
});

const rpcUnregisterSchema = z.object({
  method: z.string().min(1),
});

export function registerRpcHandlers(
  socket: SocketWithData,
  rpcRegistry: RpcRegistry
): void {
  socket.on("rpc-register", (data: unknown) => {
    const parsed = rpcRegisterSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    rpcRegistry.register(socket, parsed.data.method, parsed.data.meta);
  });

  socket.on("rpc-unregister", (data: unknown) => {
    const parsed = rpcUnregisterSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    rpcRegistry.unregister(socket, parsed.data.method);
  });
}
