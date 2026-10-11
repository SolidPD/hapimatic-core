// SPDX-License-Identifier: AGPL-3.0-only
import type { Socket } from "socket.io";
// Type-only import — the runtime value never flows the other way (RpcRegistry
// is passed INTO registerRpcHandlers as a parameter), so this type-only cycle
// with rpcHandlers.ts is fully erased at compile time (issue #2417, KD-2).
import type { CapabilityMeta } from "./handlers/cli/rpcHandlers";

/**
 * Structured warn sink. Defaults to console.warn with a `[RpcRegistry]` prefix
 * (the server socket/sync layer's convention, cf. rpcGateway.ts). Injectable so
 * tests can assert the D2-A overwrite warning fired without console spying.
 */
export type RpcRegistryWarn = (
  message: string,
  context?: Record<string, unknown>
) => void;

const defaultWarn: RpcRegistryWarn = (message, context) =>
  console.warn(`[RpcRegistry] ${message}`, context ?? {});

/**
 * Strip the leading `<scopePrefix>:` that RpcHandlerManager.getPrefixedMethod
 * adds, leaving the bare method name. Scope prefixes (session/machine ids) and
 * method names (hyphenated) contain no `:`, so splitting on the FIRST `:` is
 * unambiguous; a key with no `:` is returned unchanged.
 */
function stripScopePrefix(fullMethod: string): string {
  const idx = fullMethod.indexOf(":");
  return idx === -1 ? fullMethod : fullMethod.slice(idx + 1);
}

export class RpcRegistry {
  private readonly methodToSocketId: Map<string, string> = new Map();
  private readonly socketIdToMethods: Map<string, Set<string>> = new Map();
  private readonly methodToMeta: Map<string, CapabilityMeta> = new Map();
  private readonly warn: RpcRegistryWarn;

  constructor(options?: { warn?: RpcRegistryWarn }) {
    this.warn = options?.warn ?? defaultWarn;
  }

  register(socket: Socket, method: string, meta?: CapabilityMeta): void {
    if (!method) {
      return;
    }

    // D2-A: warn when a method already owned by a DIFFERENT socket is being
    // re-pointed — a cross-session capture / scope-prefix-collision accident
    // hazard. A same-socket re-register (e.g. a launcher teardown stub) is not
    // an ownership change and stays silent.
    const existingOwner = this.methodToSocketId.get(method);
    if (existingOwner !== undefined && existingOwner !== socket.id) {
      this.warn("rpc-register overwrites a method owned by another socket", {
        method,
        previousSocketId: existingOwner,
        newSocketId: socket.id,
      });
    }

    this.methodToSocketId.set(method, socket.id);

    // Set-or-delete symmetry (issue #2417, expert-review 1B-2): store meta when
    // provided; a bare re-register (old-client shape or teardown stub) DELETES
    // any stale meta, so name-only listings degrade gracefully.
    if (meta) {
      this.methodToMeta.set(method, meta);
    } else {
      this.methodToMeta.delete(method);
    }

    const existing = this.socketIdToMethods.get(socket.id);
    if (existing) {
      existing.add(method);
    } else {
      this.socketIdToMethods.set(socket.id, new Set([method]));
    }
  }

  unregister(socket: Socket, method: string): void {
    const socketId = this.methodToSocketId.get(method);
    if (socketId === socket.id) {
      this.methodToSocketId.delete(method);
      // Meta deletion stays INSIDE the ownership guard: on reconnect the NEW
      // socket re-registers before the OLD socket's disconnect fires, so an
      // unconditional delete would wipe freshly re-announced meta (issue #2417,
      // expert-review 1B-2 / [2417-5]).
      this.methodToMeta.delete(method);
    }

    const methods = this.socketIdToMethods.get(socket.id);
    if (methods) {
      methods.delete(method);
      if (methods.size === 0) {
        this.socketIdToMethods.delete(socket.id);
      }
    }
  }

  unregisterAll(socket: Socket): void {
    const methods = this.socketIdToMethods.get(socket.id);
    if (!methods) {
      return;
    }
    for (const method of methods) {
      const socketId = this.methodToSocketId.get(method);
      if (socketId === socket.id) {
        this.methodToSocketId.delete(method);
        // Same ownership guard as unregister() — only drop meta we still own,
        // never a successor socket's freshly re-announced entry.
        this.methodToMeta.delete(method);
      }
    }
    this.socketIdToMethods.delete(socket.id);
  }

  getSocketIdForMethod(method: string): string | null {
    return this.methodToSocketId.get(method) ?? null;
  }

  /**
   * Read API for the enumeration route (#2418). Returns the CapabilityMeta a
   * method was registered with, or null when it was registered name-only
   * (old-client shape / mixed-version fleet). Keyed by the full wire method
   * (`<scopePrefix>:<method>`), consistent with getSocketIdForMethod.
   */
  getMeta(method: string): CapabilityMeta | null {
    return this.methodToMeta.get(method) ?? null;
  }

  /**
   * Enumerate the methods a given socket registered, each with its meta (or
   * null for name-only). Method names are returned WITHOUT their scope prefix
   * so #2418 presents bare capability names. Scoping to one socketId is
   * structurally leak-proof: a socket carries exactly one scope (a session id
   * OR a machine id), so a session read can never surface machine entries
   * (issue #2417, expert-review 1B-5). #2418 owns the HTTP surface; this stays
   * intentionally minimal.
   */
  getMethodsForSocket(
    socketId: string
  ): { method: string; meta: CapabilityMeta | null }[] {
    const methods = this.socketIdToMethods.get(socketId);
    if (!methods) {
      return [];
    }
    return Array.from(methods, fullMethod => ({
      method: stripScopePrefix(fullMethod),
      meta: this.methodToMeta.get(fullMethod) ?? null,
    }));
  }

  /**
   * Enumerate EVERY registered method WITH its `CapabilityMeta`, across all
   * connected sockets, scope-prefix STRIPPED (issue #3743 R6 — the capability
   * catalog's live RPC section). Methods registered name-only (old-client shape /
   * mixed-version fleet) carry no meta and are omitted, so the section lists only
   * meta-bearing capabilities. With zero connected sessions this returns `[]`,
   * so the catalog serves `rpc: []` — never a 503. Keys are the bare method name
   * (the session/machine scope prefix is stripped, matching `getMethodsForSocket`).
   */
  listMeta(): Array<[string, CapabilityMeta]> {
    const out: Array<[string, CapabilityMeta]> = [];
    for (const [fullMethod, meta] of this.methodToMeta) {
      out.push([stripScopePrefix(fullMethod), meta]);
    }
    return out;
  }

  /**
   * The number of currently-connected sockets that have registered at least one
   * method — the `rpcObserved.sockets` provenance the capability audit needs (issue
   * #3744, R2). A zero-socket sample is `unknown`, never `clean`. Read-only.
   */
  connectedSocketCount(): number {
    return this.socketIdToMethods.size;
  }

  /**
   * Every distinct method announced across ALL connected sockets, scope-prefix
   * STRIPPED — the reverse-drift DENOMINATOR the capability audit needs (issue
   * #3744, R2). Unlike `listMeta()` (meta-bearing only), this includes name-only
   * registrations, so `listAll() ∖ listMeta()` is exactly the undescribed
   * (reverse-drift) methods. Read-only; there is no all-methods enumerator otherwise.
   */
  listAll(): string[] {
    const bare = new Set<string>();
    for (const fullMethod of this.methodToSocketId.keys()) {
      bare.add(stripScopePrefix(fullMethod));
    }
    return [...bare];
  }

  hasAnyHandlerMatching(suffix: string): boolean {
    for (const method of this.methodToSocketId.keys()) {
      if (method.endsWith(suffix)) return true;
    }
    return false;
  }
}
