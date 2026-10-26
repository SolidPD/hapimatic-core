// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API-key references (#5127): a session binds a vault key by REFERENCE, never by
 * value. Two forms ride the existing `apiKeyId` string, so every hop that already
 * carries `apiKeyId` carries a reference unchanged:
 *
 * - **bare** `<id>`: a key in the vault of the node that resolves the reference.
 *   Today's form; the helper reads the local vault and no server call is made.
 * - **qualified** `<uuid>@<homeNodeId>`: a key in the vault of `homeNodeId`, the
 *   home's own `federationConfig.nodeId`. The resolving node asks the home for it
 *   over the federation link, and only when the home has shared the key.
 *
 * A bare id is never forced into the UUID shape, so every existing local binding
 * resolves exactly as before. A string containing `@` is always a qualified ref:
 * it either parses or is refused, and is never read as a local id.
 */

/** Longest reference accepted, qualified or bare. */
export const API_KEY_REF_MAX_LENGTH = 200;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NODE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Node ids that can never name a key's home: placeholders, not identities.
 *  Includes `LOCAL_NODE_ID` from `./federation`, which this module cannot
 *  import (federation.ts imports it); apiKeyRef.test.ts asserts the overlap. */
export const UNUSABLE_SHARING_NODE_IDS: ReadonlySet<string> = new Set([
  "unknown",
  "local",
]);

/**
 * True when `nodeId` can serve as a key's home in a qualified ref: well-formed,
 * and not a placeholder a standalone or unconfigured node reports for itself.
 */
export function isUsableNodeIdForSharing(
  nodeId: string | null | undefined
): nodeId is string {
  if (typeof nodeId !== "string") return false;
  if (!NODE_ID_RE.test(nodeId)) return false;
  return !UNUSABLE_SHARING_NODE_IDS.has(nodeId.toLowerCase());
}

/** The parsed form of a reference. `homeNodeId` is null for a bare id. */
export type ParsedApiKeyRef = { id: string; homeNodeId: string | null };

/**
 * Parse a reference. Returns null for anything malformed: an empty string, a
 * string over {@link API_KEY_REF_MAX_LENGTH}, a qualified ref whose id is not a
 * UUID or whose node id is unusable, or more than one `@`.
 */
export function parseApiKeyRef(
  ref: string | null | undefined
): ParsedApiKeyRef | null {
  if (typeof ref !== "string") return null;
  if (ref.length === 0 || ref.length > API_KEY_REF_MAX_LENGTH) return null;
  const at = ref.indexOf("@");
  if (at === -1) return { id: ref, homeNodeId: null };
  const id = ref.slice(0, at);
  const homeNodeId = ref.slice(at + 1);
  if (!UUID_RE.test(id)) return null;
  if (!isUsableNodeIdForSharing(homeNodeId)) return null;
  return { id, homeNodeId };
}

/** True when `ref` is a well-formed qualified ref (`<uuid>@<homeNodeId>`). */
export function isQualifiedApiKeyRef(ref: string | null | undefined): boolean {
  return parseApiKeyRef(ref)?.homeNodeId != null;
}

/** Build a qualified ref. The caller passes a vault id and the home's node id. */
export function formatApiKeyRef(id: string, homeNodeId: string): string {
  return `${id}@${homeNodeId}`;
}

/**
 * The reference a spawn should carry for a key, from the point of view of the
 * node whose UI picked it. A key on that node, spawned on that node, keeps its
 * bare id (today's form). Every other case carries the qualified ref: a remote
 * target must know which node holds the key, even when that node is the UI node.
 */
export function bindingRefForTarget(
  key: { id: string; homeNodeId: string },
  ctx: { uiNodeId: string; targetNodeId: string }
): string {
  if (key.homeNodeId === ctx.uiNodeId && ctx.targetNodeId === ctx.uiNodeId) {
    return key.id;
  }
  return formatApiKeyRef(key.id, key.homeNodeId);
}

/**
 * Normalize a ref for the node `selfNodeId`: a qualified ref homed on this node
 * becomes its bare id, so a session's stored `apiKeyId` is bare for a local key
 * and qualified only for a key that lives elsewhere. Anything else is returned
 * unchanged (a malformed ref is left for the caller to refuse).
 */
export function canonicalApiKeyRef(
  ref: string,
  selfNodeId: string | null | undefined
): string {
  const parsed = parseApiKeyRef(ref);
  if (!parsed || parsed.homeNodeId === null) return ref;
  if (selfNodeId && parsed.homeNodeId === selfNodeId) return parsed.id;
  return ref;
}

/** The vault id inside any ref: the bare id itself, or the qualified ref's id. */
export function apiKeyRefVaultId(ref: string): string {
  return parseApiKeyRef(ref)?.id ?? ref;
}
