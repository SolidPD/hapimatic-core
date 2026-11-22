// SPDX-License-Identifier: AGPL-3.0-only
/**
 * #6715: the ONE caller-origin module (design §4.1, directive R1 and R2).
 *
 * It decides, from facts read off the AUTHENTICATED request and never from a
 * request body, how a message arrived:
 *   - `class`: the existing origin class, unchanged in step 0 (a header-less post
 *     stays `web-user`; #6633 renames it later, a known break);
 *   - `evidence`: `browser` or `none`. `browser` is a HINT, not a proof: every
 *     login ends in the same node token, so a session that builds a request by
 *     hand, or drives a real browser, still gets `browser` (ladder L3, L4). It
 *     tells apart only the routes that send no browser header (loop ticks,
 *     scripts, `hapi api call`, a send with the session variable unset);
 *   - `door`: the way in, recorded for the audit;
 *   - `facts`: the raw facts behind the verdict, none of them a secret.
 *
 * This module lives under `sync/` because `sync/` and `services/` must not
 * import from `web/`. In step 0 it serves the message origin and the token gate
 * only (review M-1). Its later charter, for #5632 and #6633, is every other
 * place that reads the session header today:
 *   - `web/routes/agentEscalation.ts`: `classifyCaller`, `resolveCallerSession`
 *     and `isAgentRequest`;
 *   - `web/routes/pinRouteHelpers.ts` (the Pins floors);
 *   - `web/routes/worktreeRemoval.ts` (the owner check);
 *   - `web/routes/permissions.ts` (the self-permission floor).
 * #6633 adds a credential field to {@link RequestFacts} and changes nothing else.
 */
import { z } from "zod";

/** The origin-class vocabulary (registry §4.1), declared once (C7). The flat
 *  grant `origin` string rp1-home reads is derived from it, so a NEW value is a
 *  cross-repo contract: it must reach rp1-home's ORIGIN_RE first (rp1-home#3304). */
export const ORIGIN_CLASSES = [
  "web-user",
  "cli-api",
  "federation",
  "bare-terminal",
] as const;
export type OriginClass = (typeof ORIGIN_CLASSES)[number];

/** `browser` only on the browser's own headers (R2); everything else `none`. */
export const ORIGIN_EVIDENCE = ["browser", "none"] as const;
export type OriginEvidence = (typeof ORIGIN_EVIDENCE)[number];

/** The ways in (R1). `unattributed` is a header-less post without browser
 *  evidence; `queue-drain` and `engine` name server-side senders. */
export const ORIGIN_DOORS = [
  "browser",
  "unattributed",
  "cli",
  "capability-invoker",
  "federation",
  "pins-submit",
  "queue-drain",
  "engine",
] as const;
export type OriginDoor = (typeof ORIGIN_DOORS)[number];

/** The caller-provenance header. Must equal `CALLER_SESSION_HEADER` in
 *  `web/routes/agentEscalation.ts` (a test pins it). */
export const CALLER_SESSION_HEADER = "X-Hapi-Session-Id";
/** The capability invoker's re-entrancy header. Must equal
 *  `CAPABILITY_DEPTH_HEADER` in `web/routes/agentEscalation.ts` (a test pins it). */
export const CAPABILITY_DEPTH_HEADER = "X-Hapi-Capability-Depth";

/** What the request carried, read once. `undefined` means the header was absent. */
export interface RequestFacts {
  sessionHeader?: string;
  depthHeader?: string;
  origin?: string;
  host?: string;
  secFetchSite?: string;
  /** The token's `uid` claim. */
  uid?: number;
  /** The session the raw header resolves to (by id, then tag, in the caller's
   *  namespace), when the door can resolve it. UNVERIFIED: the header is
   *  self-declared. */
  resolvedSessionId?: string;
}

/** The raw facts recorded beside the verdict (R1), none of them a secret. */
export interface OriginFacts {
  originState: "absent" | "null" | "present";
  originMatchesHost: boolean | "unknown";
  /** The header value, or `absent`. */
  secFetchSite: string;
}

export interface CallerOrigin {
  class: OriginClass;
  uid?: number;
  /** The RAW session header (today's field; the ceiling guard reads it). */
  sessionId?: string;
  /** The resolved sender session (R10), stored apart from the raw header and
   *  UNVERIFIED. */
  senderSessionId?: string;
  evidence: OriginEvidence;
  door: OriginDoor;
  facts: OriginFacts;
}

/**
 * What the forwarding node derived for a forwarded send or Pins Submit (R3),
 * kept by the owning node beside the `federation` class. Trusted because the
 * sender holds the federation token (ladder L5, an open residual).
 */
export interface ForwardedVia {
  /** Absent when the forwarder sent no valid class (an empty origin). */
  class?: OriginClass;
  evidence: OriginEvidence;
  door?: OriginDoor;
  facts?: OriginFacts;
  /** The raw session header the forwarder saw. */
  senderRaw?: string;
  /** The sender session the forwarder resolved. UNVERIFIED. */
  senderSessionId?: string;
  /** The forwarding node's federation id (for the observe log). */
  forwarderNode?: string;
}

/** The longest header value kept in a recorded fact. */
const MAX_FACT_LENGTH = 64;

/**
 * Read the facts from a request's headers. `Tailscale-User-*`, `X-Forwarded-*`
 * and `Referer` are never read: a session reaches the loopback port directly,
 * so those headers are whatever it chooses to send (R2).
 */
export function readRequestFacts(
  header: (name: string) => string | undefined,
  uid: number | undefined,
  resolvedSessionId?: string
): RequestFacts {
  const facts: RequestFacts = {};
  const sessionHeader = header(CALLER_SESSION_HEADER);
  if (sessionHeader !== undefined) facts.sessionHeader = sessionHeader;
  const depthHeader = header(CAPABILITY_DEPTH_HEADER);
  if (depthHeader !== undefined) facts.depthHeader = depthHeader;
  const origin = header("Origin");
  if (origin !== undefined) facts.origin = origin;
  const host = header("Host");
  if (host !== undefined) facts.host = host;
  const secFetchSite = header("Sec-Fetch-Site");
  if (secFetchSite !== undefined) facts.secFetchSite = secFetchSite;
  if (uid !== undefined) facts.uid = uid;
  if (resolvedSessionId !== undefined) {
    facts.resolvedSessionId = resolvedSessionId;
  }
  return facts;
}

function originState(origin: string | undefined): OriginFacts["originState"] {
  if (origin === undefined) return "absent";
  const trimmed = origin.trim();
  if (trimmed === "") return "absent";
  // The serialization of an opaque origin (a sandboxed frame, a file page).
  if (trimmed.toLowerCase() === "null") return "null";
  return "present";
}

function originMatchesHost(
  origin: string | undefined,
  state: OriginFacts["originState"],
  host: string | undefined
): OriginFacts["originMatchesHost"] {
  if (state !== "present" || origin === undefined) return "unknown";
  const trimmedHost = host?.trim().toLowerCase();
  if (!trimmedHost) return "unknown";
  let originHost: string;
  try {
    originHost = new URL(origin.trim()).host.toLowerCase();
  } catch {
    return false;
  }
  return originHost !== "" && originHost === trimmedHost;
}

function recordedSecFetchSite(value: string | undefined): string {
  if (value === undefined) return "absent";
  return value.trim().toLowerCase().slice(0, MAX_FACT_LENGTH);
}

/**
 * Decide the caller origin (R1, R2). `evidence` is `browser` only when ALL hold:
 *   - no session header (present at all, even empty);
 *   - no capability-invoker depth header;
 *   - `Origin` present and not the literal `null` (its value is never compared
 *     with any CORS list, which defaults to localhost and is `*` on peers);
 *   - `Sec-Fetch-Site`, when present, says `same-origin`.
 * The class keeps today's rule: a non-empty session header is `cli-api` with the
 * raw header as `sessionId`; anything else is `web-user` with the token's `uid`.
 */
export function deriveCallerOrigin(
  f: RequestFacts,
  options?: { door?: "pins-submit" }
): CallerOrigin {
  const state = originState(f.origin);
  const facts: OriginFacts = {
    originState: state,
    originMatchesHost: originMatchesHost(f.origin, state, f.host),
    secFetchSite: recordedSecFetchSite(f.secFetchSite),
  };
  const hasSessionHeader = f.sessionHeader !== undefined;
  const hasDepthHeader = f.depthHeader !== undefined;
  const fetchSiteOk =
    f.secFetchSite === undefined || facts.secFetchSite === "same-origin";
  const evidence: OriginEvidence =
    !hasSessionHeader && !hasDepthHeader && state === "present" && fetchSiteOk
      ? "browser"
      : "none";

  const stamped = Boolean(f.sessionHeader);
  let door: OriginDoor;
  if (options?.door) door = options.door;
  else if (hasDepthHeader) door = "capability-invoker";
  else if (stamped) door = "cli";
  else door = evidence === "browser" ? "browser" : "unattributed";

  if (stamped) {
    return {
      class: "cli-api",
      sessionId: f.sessionHeader,
      ...(f.resolvedSessionId !== undefined
        ? { senderSessionId: f.resolvedSessionId }
        : {}),
      evidence,
      door,
      facts,
    };
  }
  return {
    class: "web-user",
    ...(f.uid !== undefined ? { uid: f.uid } : {}),
    evidence,
    door,
    facts,
  };
}

/** The longest forwarded record-only identifier kept (the resolved sender id,
 *  the forwarder's node id). The raw sender `sessionId` is never capped: it is
 *  the stamp, and a session controls its own header (L1). */
const MAX_FORWARDED_ID_LENGTH = 256;

const forwardedIdSchema = z.string().min(1).max(MAX_FORWARDED_ID_LENGTH);
const originClassSchema = z.enum(ORIGIN_CLASSES);
const evidenceSchema = z.enum(ORIGIN_EVIDENCE);
const doorSchema = z.enum(ORIGIN_DOORS);
const originFactsSchema = z
  .object({
    originState: z.enum(["absent", "null", "present"]),
    originMatchesHost: z.union([z.boolean(), z.literal("unknown")]),
    secFetchSite: z.string().max(MAX_FACT_LENGTH),
  })
  .passthrough();
/** The forwarded origin body: every field optional, unknown fields ignored
 *  (an older or newer forwarder sends what it knows). */
const forwardedOriginSchema = z
  .object({
    class: z.unknown(),
    uid: z.unknown(),
    sessionId: z.unknown(),
    senderSessionId: z.unknown(),
    evidence: z.unknown(),
    door: z.unknown(),
    facts: z.unknown(),
    forwarderNode: z.unknown(),
  })
  .partial()
  .passthrough();

/** A {@link CallerOrigin}-shaped `federation` origin as the owning node keeps it. */
export interface ReceivedForwardedOrigin {
  class: "federation";
  uid?: number;
  sessionId?: string;
  via: ForwardedVia;
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * The owning node's read of a forwarded origin (R3), shared by the send
 * receiver and the Pins receiver. It keeps `uid` and the raw `sessionId` on top,
 * as before (the ceiling guard reads `sessionId` there), and the forwarder's
 * verdict as `via`. Each field is validated alone and dropped when invalid. A
 * forward without a valid verdict reads `evidence: none`, and `browser` is kept
 * only for a forwarded header-less post at this receiver's own door (`browser`
 * for a send, `pins-submit` for a Submit) whose facts show a present Origin and
 * an acceptable Fetch Metadata value; any other `browser` claim is recorded
 * `none`. A nested `via` in the body is never read. No body origin at all gives
 * `undefined`, so the token gate keeps refusing an origin-less code.
 */
export function receiveForwardedOrigin(
  value: unknown,
  receiver: "send" | "pins-submit"
): ReceivedForwardedOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const body = parsed(forwardedOriginSchema, value) ?? {};
  const uid = parsed(z.number().int().nonnegative(), body.uid);
  // Any string, as ms-dev kept it: a cap would drop a padded header, and the
  // forward would then read as operator input with no sender to check (L1).
  const sessionId = parsed(z.string(), body.sessionId);
  const senderSessionId = parsed(forwardedIdSchema, body.senderSessionId);
  const forwarderNode = parsed(forwardedIdSchema, body.forwarderNode);
  const viaClass = parsed(originClassSchema, body.class);
  const claimed = parsed(evidenceSchema, body.evidence);
  const door = parsed(doorSchema, body.door);
  const facts = parsed(originFactsSchema, body.facts);

  const expectedDoor: OriginDoor =
    receiver === "send" ? "browser" : "pins-submit";
  const factsShowBrowser =
    facts !== undefined &&
    facts.originState === "present" &&
    (facts.secFetchSite === "absent" || facts.secFetchSite === "same-origin");
  const evidence: OriginEvidence =
    claimed === "browser" &&
    viaClass === "web-user" &&
    sessionId === undefined &&
    door === expectedDoor &&
    factsShowBrowser
      ? "browser"
      : "none";

  const via: ForwardedVia = {
    ...(viaClass !== undefined ? { class: viaClass } : {}),
    evidence,
    ...(door !== undefined ? { door } : {}),
    ...(facts !== undefined
      ? {
          facts: {
            originState: facts.originState,
            originMatchesHost: facts.originMatchesHost,
            secFetchSite: facts.secFetchSite,
          },
        }
      : {}),
    ...(sessionId !== undefined ? { senderRaw: sessionId } : {}),
    ...(senderSessionId !== undefined ? { senderSessionId } : {}),
    ...(forwarderNode !== undefined ? { forwarderNode } : {}),
  };
  return {
    class: "federation",
    ...(uid !== undefined ? { uid } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    via,
  };
}
