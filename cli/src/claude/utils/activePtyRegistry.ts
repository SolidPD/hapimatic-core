// SPDX-License-Identifier: MIT
import type { ClaudePtyHandle } from "../claudePty";

const registry = new Map<string, ClaudePtyHandle>();

export function registerActivePty(
  sessionId: string,
  handle: ClaudePtyHandle
): void {
  registry.set(sessionId, handle);
}

export function unregisterActivePty(sessionId: string): void {
  registry.delete(sessionId);
}

export function getActivePty(sessionId: string): ClaudePtyHandle | undefined {
  return registry.get(sessionId);
}
