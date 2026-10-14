// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration and handler execution (no encryption).
 */

import { logger as defaultLogger } from "@/ui/logger";
import { NO_META_TEARDOWN } from "./types";
import type {
  CapabilityMeta,
  RpcHandler,
  RpcHandlerConfig,
  RpcHandlerMap,
  RpcRequest,
} from "./types";
import type { Socket } from "socket.io-client";

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export class RpcHandlerManager {
  private handlers: RpcHandlerMap = new Map();
  private readonly meta: Map<string, CapabilityMeta> = new Map();
  private readonly scopePrefix: string;
  private readonly logger: (message: string, data?: unknown) => void;
  private socket: Socket | null = null;

  constructor(config: RpcHandlerConfig) {
    this.scopePrefix = config.scopePrefix;
    this.logger =
      config.logger || ((msg, data) => defaultLogger.debug(msg, data));
  }

  registerHandler<TRequest = unknown, TResponse = unknown>(
    method: string,
    handler: RpcHandler<TRequest, TResponse>,
    meta: CapabilityMeta | typeof NO_META_TEARDOWN
  ): void {
    const prefixedMethod = this.getPrefixedMethod(method);

    this.handlers.set(prefixedMethod, handler as RpcHandler);

    // Normalize the sentinel by TYPE, not identity (issue #3742, KD-1): the
    // `Symbol.for(...)` registry sentinel is the SAME value across a possible
    // double module instantiation (Bun single-exe + cli's tsconfig pulling in
    // `../server/src/**`), and `typeof meta === "symbol"` is identity-independent,
    // so a sentinel can never leak onto the wire. `realMeta` is `undefined` for
    // the sentinel, driving the meta-less path BYTE-IDENTICALLY to a pre-#3742
    // no-meta registration — the type change is the only new behavior (KD-2).
    const realMeta = typeof meta === "symbol" ? undefined : meta;

    // Set-or-delete symmetry: a meta-less re-registration of a method that
    // previously HAD meta (every launcher teardown/deactivate stub) MUST clear
    // the stale entry, or the reconnect re-announce re-attaches rich meta to a
    // no-op handler (issue #2417, expert-review 1B-2).
    if (realMeta) {
      this.meta.set(prefixedMethod, realMeta);
    } else {
      this.meta.delete(prefixedMethod);
    }

    if (this.socket) {
      this.socket.emit(
        "rpc-register",
        this.buildRegisterPayload(prefixedMethod, realMeta)
      );
    }
  }

  async handleRequest(request: RpcRequest): Promise<string> {
    try {
      const handler = this.handlers.get(request.method);
      if (!handler) {
        this.logger("[RPC] [ERROR] Method not found", {
          method: request.method,
        });
        return JSON.stringify({
          type: "error",
          errorMessage: "Method not found",
        });
      }

      const params = safeJsonParse(request.params);
      const result = await handler(params as Parameters<typeof handler>[0]);
      return JSON.stringify(result);
    } catch (error) {
      const details =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { error: String(error) };
      this.logger("[RPC] [ERROR] Error handling request", details);
      return JSON.stringify({
        type: "error",
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  onSocketConnect(socket: Socket): void {
    this.socket = socket;
    for (const [prefixedMethod] of this.handlers) {
      // Re-announce each registration including its stored meta (if any) —
      // same payload shape as registerHandler, via the shared builder.
      socket.emit(
        "rpc-register",
        this.buildRegisterPayload(prefixedMethod, this.meta.get(prefixedMethod))
      );
    }
  }

  onSocketDisconnect(): void {
    this.socket = null;
  }

  getHandlerCount(): number {
    return this.handlers.size;
  }

  hasHandler(method: string): boolean {
    const prefixedMethod = this.getPrefixedMethod(method);
    return this.handlers.has(prefixedMethod);
  }

  clearHandlers(): void {
    this.handlers.clear();
    this.meta.clear();
    this.logger("Cleared all RPC handlers");
  }

  /**
   * Build the `rpc-register` payload. When meta is absent, return the bare
   * `{ method }` shape — never `{ method, meta: undefined }` — so a new CLI's
   * announcement is byte-identical to an old client's (issue #2417, KD-5/R2).
   * Centralized so the register + reconnect emit sites cannot drift and break
   * the mixed-version-fleet contract (the design note's shape-drift class).
   */
  private buildRegisterPayload(
    prefixedMethod: string,
    meta: CapabilityMeta | undefined
  ): { method: string; meta?: CapabilityMeta } {
    return meta ? { method: prefixedMethod, meta } : { method: prefixedMethod };
  }

  private getPrefixedMethod(method: string): string {
    return `${this.scopePrefix}:${method}`;
  }
}

export function createRpcHandlerManager(
  config: RpcHandlerConfig
): RpcHandlerManager {
  return new RpcHandlerManager(config);
}
