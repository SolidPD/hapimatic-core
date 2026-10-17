// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local hardware companion — the VM-side pairing service (issue #4352, Task 2).
 *
 * Owns, IN MEMORY ONLY:
 *   - pending pairing requests opened by a bench helper (`hapi companion start`),
 *     each with a short code the user enters on the VM side;
 *   - pairings: a per-pairing Ed25519 certificate authority, the hash of a
 *     pairing-scoped token, the pinned helper host key, and the principals
 *     (one per cloud session) the bench has been asked to admit;
 *   - liveness: the last heartbeat time, from which "offline" (no new
 *     certificates) and "stale" (the pairing ends, the CA is discarded) follow.
 *
 * Nothing is persisted: a server restart ends every pairing (fail-closed). The
 * CA private key never leaves this process and is dropped when the pairing
 * ends. Design and lifetime table: docs/internal/architecture/hardware-companion.md.
 *
 * Import hygiene: this file is also type-checked by `typecheck:cli` (cli's
 * tsconfig includes ../server/src), so it uses relative and `@hapi/*` imports
 * only — never the `@/` alias.
 */
import {
  createHash,
  generateKeyPairSync,
  randomBytes as nodeRandomBytes,
  sign as nodeSign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import {
  COMPANION_TOKEN_PREFIX,
  DEFAULT_COMPANION_TIMING,
  base64UrlToBytes,
  ed25519LineFingerprint,
  encodePairingCode,
  formatEd25519PublicKey,
  formatPairingCode,
  isCompanionPrincipal,
  normalizePairingCode,
  parseEd25519PublicKey,
  principalForSession,
  signEd25519UserCertificate,
  type CompanionCertificateResult,
  type CompanionClaimResult,
  type CompanionConfirmResult,
  type CompanionHeartbeat,
  type CompanionHeartbeatResult,
  type CompanionPairRequestCreate,
  type CompanionPairRequestCreated,
  type CompanionPairRequestInfo,
  type CompanionPairingSummary,
  type CompanionPairingsList,
  type CompanionPrivilege,
  type CompanionTiming,
} from "@hapi/protocol/companion";

/** How long a pairing request (and its code) stays valid. */
export const PAIR_REQUEST_TTL_MS = 10 * 60_000;
/** At most this many pending requests across the whole server. */
export const MAX_PENDING_REQUESTS = 32;
/** Ended pairings stay listable this long, without their CA. */
export const ENDED_RETENTION_MS = 60 * 60_000;
/** Clock-skew allowance on a certificate's `validAfter`. */
export const CERT_BACKDATE_MS = 60_000;

/** What the service needs to know about a cloud session. */
export type CompanionSessionInfo = {
  id: string;
  label: string;
  active: boolean;
};

/** Resolve a session id or tag within a namespace; `null` when unknown. */
export type CompanionSessionLookup = (
  namespace: string,
  sessionIdOrTag: string
) => CompanionSessionInfo | null;

export type CompanionPairingServiceOptions = {
  lookupSession: CompanionSessionLookup;
  timing?: Partial<CompanionTiming>;
  now?: () => number;
  randomBytes?: (size: number) => Uint8Array;
};

/** A typed failure the routes map to an HTTP status. */
export class CompanionError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CompanionError";
  }
}

type PendingRequest = {
  requestId: string;
  code: string;
  pollSecretHash: Buffer;
  createdAt: number;
  expiresAt: number;
  hostKey: string;
  hostKeyFingerprint: string;
  hostname: string;
  localUser: string;
  os: string;
  arch: string;
  privilege: CompanionPrivilege;
  listenAddress: string;
  /** Set when the VM side confirms; the plaintext token waits here until claimed. */
  confirmed: { pairingId: string; token: string } | null;
};

type PrincipalRecord = {
  principal: string;
  sessionId: string;
  sessionLabel: string;
  state: "requested" | "approved" | "denied";
  validUntil: number | null;
  port: number | null;
  liveConnections: number;
  sources: string[];
};

type Pairing = {
  pairingId: string;
  namespace: string;
  tokenHash: Buffer;
  hostKey: string;
  hostKeyFingerprint: string;
  hostname: string;
  localUser: string;
  os: string;
  arch: string;
  privilege: CompanionPrivilege;
  listenAddress: string;
  /** `null` once the pairing ended: the CA private key is discarded then. */
  caPrivateKey: KeyObject | null;
  caPublicKey: Uint8Array;
  caPublicKeyLine: string;
  caFingerprint: string;
  createdAt: number;
  lastHeartbeatAt: number | null;
  ended: { at: number; reason: string } | null;
  serial: bigint;
  principals: Map<string, PrincipalRecord>;
};

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Strip control characters and cap the length of a label shown on the bench. */
function cleanLabel(value: string, max = 80): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, max)
  );
}

export class CompanionPairingService {
  readonly timing: CompanionTiming;
  private readonly lookupSession: CompanionSessionLookup;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly pairings = new Map<string, Pairing>();

  constructor(options: CompanionPairingServiceOptions) {
    this.lookupSession = options.lookupSession;
    this.timing = { ...DEFAULT_COMPANION_TIMING, ...options.timing };
    this.now = options.now ?? (() => Date.now());
    this.random =
      options.randomBytes ?? (size => new Uint8Array(nodeRandomBytes(size)));
  }

  // ── Bench helper side (no JWT) ────────────────────────────────────────────

  /** Open a pending request; the returned code is shown on the bench. */
  async createPairRequest(
    input: CompanionPairRequestCreate
  ): Promise<CompanionPairRequestCreated> {
    this.sweep();
    if (this.requests.size >= MAX_PENDING_REQUESTS) {
      throw new CompanionError(
        503,
        "too_many_requests",
        "Too many pending pairing requests; try again later"
      );
    }
    let hostKeyFingerprint: string;
    try {
      parseEd25519PublicKey(input.hostKey);
      hostKeyFingerprint = await ed25519LineFingerprint(input.hostKey);
    } catch (error) {
      throw new CompanionError(
        400,
        "bad_host_key",
        error instanceof Error ? error.message : "invalid host key"
      );
    }
    let code = encodePairingCode(this.random(5));
    for (let i = 0; i < 8 && this.findRequestByCode(code); i++) {
      code = encodePairingCode(this.random(5));
    }
    const requestId = base64Url(this.random(12));
    const pollSecret = base64Url(this.random(24));
    const now = this.now();
    const request: PendingRequest = {
      requestId,
      code,
      pollSecretHash: sha256(pollSecret),
      createdAt: now,
      expiresAt: now + PAIR_REQUEST_TTL_MS,
      hostKey: input.hostKey.trim().split(/\s+/).slice(0, 2).join(" "),
      hostKeyFingerprint,
      hostname: cleanLabel(input.hostname, 253),
      localUser: input.localUser,
      os: cleanLabel(input.os, 32),
      arch: cleanLabel(input.arch, 32),
      privilege: input.privilege,
      listenAddress: input.listenAddress,
      confirmed: null,
    };
    this.requests.set(requestId, request);
    return {
      requestId,
      code: formatPairingCode(code),
      pollSecret,
      expiresAt: request.expiresAt,
      hostKeyFingerprint,
    };
  }

  /**
   * The helper polls until the VM side confirms. The token is handed out ONCE;
   * the request is deleted on the paired answer.
   */
  claimPairRequest(
    requestId: string,
    pollSecret: string
  ): CompanionClaimResult {
    this.sweep();
    const request = this.requests.get(requestId);
    if (!request || !this.secretMatches(request.pollSecretHash, pollSecret)) {
      throw new CompanionError(
        410,
        "request_gone",
        "Pairing request expired or unknown; start again"
      );
    }
    if (!request.confirmed) {
      return { status: "pending", expiresAt: request.expiresAt };
    }
    const pairing = this.pairings.get(request.confirmed.pairingId);
    const token = request.confirmed.token;
    this.requests.delete(requestId);
    if (!pairing || pairing.ended) {
      throw new CompanionError(410, "pairing_ended", "The pairing has ended");
    }
    pairing.lastHeartbeatAt = this.now();
    return {
      status: "paired",
      pairingId: pairing.pairingId,
      token,
      caPublicKey: pairing.caPublicKeyLine,
      caFingerprint: pairing.caFingerprint,
      hostKeyFingerprint: pairing.hostKeyFingerprint,
      timing: this.timing,
      serverTime: this.now(),
    };
  }

  /** Resolve a pairing token; throws 401 for an unknown token, 410 for an ended pairing. */
  authenticateHelper(token: string | undefined): string {
    if (!token || !token.startsWith(COMPANION_TOKEN_PREFIX)) {
      throw new CompanionError(401, "bad_token", "Missing pairing token");
    }
    this.sweep();
    const hash = sha256(token);
    for (const pairing of this.pairings.values()) {
      if (
        pairing.tokenHash.length === hash.length &&
        timingSafeEqual(pairing.tokenHash, hash)
      ) {
        if (pairing.ended) {
          throw new CompanionError(
            410,
            "pairing_ended",
            `The pairing has ended (${pairing.ended.reason}); pair again`
          );
        }
        return pairing.pairingId;
      }
    }
    throw new CompanionError(401, "bad_token", "Unknown pairing token");
  }

  /**
   * One heartbeat: records liveness, applies the bench's approve/deny
   * decisions and instance reports, drops principals whose cloud session
   * ended, and renews each approved principal's `validUntil`. Renewal happens
   * only here — that is what binds it to the helper's control channel.
   */
  heartbeat(
    pairingId: string,
    report: CompanionHeartbeat
  ): CompanionHeartbeatResult {
    const pairing = this.livePairing(pairingId);
    const now = this.now();
    pairing.lastHeartbeatAt = now;

    for (const decision of report.decisions) {
      const record = pairing.principals.get(decision.principal);
      if (!record || record.state !== "requested") continue;
      record.state = decision.decision === "approve" ? "approved" : "denied";
    }
    for (const instance of report.instances) {
      const record = pairing.principals.get(instance.principal);
      if (!record || record.state !== "approved") continue;
      record.port = instance.port;
      record.liveConnections = instance.liveConnections;
      record.sources = instance.sources.map(s => cleanLabel(s, 64)).slice(0, 8);
    }
    for (const [principal, record] of pairing.principals) {
      const session = this.lookupSession(pairing.namespace, record.sessionId);
      if (!session || !session.active) {
        pairing.principals.delete(principal);
        continue;
      }
      record.sessionLabel = cleanLabel(session.label);
      if (record.state === "approved") {
        record.validUntil = now + this.timing.certTtlMs;
      }
    }
    return {
      serverTime: now,
      principals: [...pairing.principals.values()]
        .filter(r => r.state !== "denied")
        .map(r => ({
          principal: r.principal,
          sessionLabel: r.sessionLabel,
          state: r.state === "approved" ? "approved" : "requested",
          validUntil: r.state === "approved" ? r.validUntil : null,
        })),
    };
  }

  /** The helper ends its own pairing (Stop on the bench). */
  endByHelper(pairingId: string): void {
    const pairing = this.pairings.get(pairingId);
    if (pairing && !pairing.ended) this.end(pairing, "helper-stopped");
  }

  // ── VM side (JWT, namespaced) ─────────────────────────────────────────────

  /**
   * Show what a code refers to before the user confirms it. A pending request
   * belongs to no namespace until it is confirmed, so any signed-in user of this
   * instance can look a code up; the pairing is created in the confirming
   * user's namespace.
   */
  lookupCode(code: string): CompanionPairRequestInfo {
    const request = this.requestForCode(code);
    return {
      requestId: request.requestId,
      hostname: request.hostname,
      localUser: request.localUser,
      os: request.os,
      arch: request.arch,
      privilege: request.privilege,
      listenAddress: request.listenAddress,
      hostKeyFingerprint: request.hostKeyFingerprint,
      expiresAt: request.expiresAt,
    };
  }

  /**
   * Create the pairing and its CA. The caller must echo the helper's host-key
   * fingerprint it showed the user, so a code alone never creates a pairing.
   */
  async confirmCode(
    namespace: string,
    code: string,
    hostKeyFingerprint: string
  ): Promise<CompanionConfirmResult> {
    const request = this.requestForCode(code);
    if (request.confirmed) {
      throw new CompanionError(409, "already_confirmed", "Code already used");
    }
    if (request.hostKeyFingerprint !== hostKeyFingerprint.trim()) {
      throw new CompanionError(
        409,
        "fingerprint_mismatch",
        "The host-key fingerprint does not match the pairing request"
      );
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    if (typeof jwk.x !== "string") {
      throw new Error("ed25519 key export lacks a public component");
    }
    const caPublicKey = base64UrlToBytes(jwk.x);
    const pairingId = base64Url(this.random(9));
    const caPublicKeyLine = formatEd25519PublicKey(
      caPublicKey,
      `hapi-companion-ca:${pairingId}`
    );
    const caFingerprint = await ed25519LineFingerprint(caPublicKeyLine);
    const token = `${COMPANION_TOKEN_PREFIX}${base64Url(this.random(32))}`;
    const pairing: Pairing = {
      pairingId,
      namespace,
      tokenHash: sha256(token),
      hostKey: request.hostKey,
      hostKeyFingerprint: request.hostKeyFingerprint,
      hostname: request.hostname,
      localUser: request.localUser,
      os: request.os,
      arch: request.arch,
      privilege: request.privilege,
      listenAddress: request.listenAddress,
      caPrivateKey: privateKey,
      caPublicKey,
      caPublicKeyLine,
      caFingerprint,
      createdAt: this.now(),
      lastHeartbeatAt: null,
      ended: null,
      serial: 0n,
      principals: new Map(),
    };
    this.pairings.set(pairingId, pairing);
    request.confirmed = { pairingId, token };
    return { pairingId, caFingerprint, hostKeyFingerprint };
  }

  list(namespace: string): CompanionPairingsList {
    this.sweep();
    const pairings: CompanionPairingSummary[] = [];
    for (const p of this.pairings.values()) {
      if (p.namespace !== namespace) continue;
      pairings.push({
        pairingId: p.pairingId,
        state: p.ended ? "ended" : this.isOffline(p) ? "offline" : "live",
        hostname: p.hostname,
        localUser: p.localUser,
        os: p.os,
        arch: p.arch,
        privilege: p.privilege,
        listenAddress: p.listenAddress,
        hostKeyFingerprint: p.hostKeyFingerprint,
        caFingerprint: p.caFingerprint,
        createdAt: p.createdAt,
        lastHeartbeatAt: p.lastHeartbeatAt,
        endedAt: p.ended?.at ?? null,
        endReason: p.ended?.reason ?? null,
        principals: [...p.principals.values()].map(r => ({ ...r })),
      });
    }
    // Pending requests carry no namespace until confirmed; only their
    // non-secret identity is listed, so the owner can see what is waiting.
    const pending = [...this.requests.values()]
      .filter(r => !r.confirmed)
      .map(r => ({
        requestId: r.requestId,
        hostname: r.hostname,
        localUser: r.localUser,
        expiresAt: r.expiresAt,
      }));
    return { pairings, pending };
  }

  revoke(namespace: string, pairingId: string): void {
    const pairing = this.pairings.get(pairingId);
    if (!pairing || pairing.namespace !== namespace) {
      throw new CompanionError(404, "not_found", "No such pairing");
    }
    if (!pairing.ended) this.end(pairing, "revoked");
  }

  /**
   * A cloud session asks for a certificate. The first request for a session
   * registers its principal as `requested`; the bench admits it (or not) and
   * the next call returns the certificate. A certificate is signed only while
   * the session is active, the pairing is live and not offline, the bench has
   * approved the principal, and its `sshd` instance has reported a port.
   */
  requestCertificate(
    namespace: string,
    input: { pairingId?: string; session: string; publicKey: string }
  ): CompanionCertificateResult {
    const session = this.lookupSession(namespace, input.session);
    if (!session || !session.active) {
      throw new CompanionError(
        409,
        "session_inactive",
        "That session is not active"
      );
    }
    let userKey: Uint8Array;
    try {
      userKey = parseEd25519PublicKey(input.publicKey);
    } catch (error) {
      throw new CompanionError(
        400,
        "bad_public_key",
        error instanceof Error ? error.message : "invalid public key"
      );
    }
    const pairing = this.pickPairing(namespace, input.pairingId);
    if (this.isOffline(pairing)) {
      throw new CompanionError(
        409,
        "helper_offline",
        "The bench helper is not reachable; check that it is running"
      );
    }
    const principal = principalForSession(session.id);
    if (!isCompanionPrincipal(principal)) {
      throw new CompanionError(400, "bad_session", "Unusable session id");
    }
    let record = pairing.principals.get(principal);
    if (!record) {
      record = {
        principal,
        sessionId: session.id,
        sessionLabel: cleanLabel(session.label),
        state: "requested",
        validUntil: null,
        port: null,
        liveConnections: 0,
        sources: [],
      };
      pairing.principals.set(principal, record);
    }
    const base = { pairingId: pairing.pairingId, principal };
    if (record.state === "denied") return { state: "denied", ...base };
    if (record.state !== "approved" || record.port === null) {
      return { state: "requested", ...base };
    }
    const caKey = pairing.caPrivateKey;
    if (!caKey) {
      throw new CompanionError(410, "pairing_ended", "The pairing has ended");
    }
    const now = this.now();
    const validBefore = now + this.timing.certTtlMs;
    pairing.serial += 1n;
    const certificate = signEd25519UserCertificate({
      publicKey: userKey,
      caPublicKey: pairing.caPublicKey,
      sign: data => new Uint8Array(nodeSign(null, data, caKey)),
      nonce: this.random(32),
      serial: pairing.serial,
      keyId: `hapi-companion:${pairing.pairingId}:${session.id}:${pairing.serial}`,
      principals: [principal],
      validAfter: Math.floor((now - CERT_BACKDATE_MS) / 1000),
      validBefore: Math.floor(validBefore / 1000),
      comment: principal,
    });
    return {
      state: "approved",
      ...base,
      certificate,
      validBefore,
      host: pairing.listenAddress,
      port: record.port,
      user: pairing.localUser,
      hostKey: pairing.hostKey,
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private secretMatches(hash: Buffer, secret: string): boolean {
    const candidate = sha256(secret);
    return candidate.length === hash.length && timingSafeEqual(candidate, hash);
  }

  private findRequestByCode(code: string): PendingRequest | undefined {
    for (const r of this.requests.values()) if (r.code === code) return r;
    return undefined;
  }

  private requestForCode(code: string): PendingRequest {
    this.sweep();
    const normalized = normalizePairingCode(code);
    const request = normalized ? this.findRequestByCode(normalized) : undefined;
    if (!request) {
      throw new CompanionError(
        404,
        "unknown_code",
        "No pending request has that code"
      );
    }
    return request;
  }

  private livePairing(pairingId: string): Pairing {
    this.sweep();
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new CompanionError(401, "bad_token", "Unknown pairing");
    if (pairing.ended) {
      throw new CompanionError(
        410,
        "pairing_ended",
        `The pairing has ended (${pairing.ended.reason}); pair again`
      );
    }
    return pairing;
  }

  private pickPairing(namespace: string, pairingId?: string): Pairing {
    this.sweep();
    if (pairingId) {
      const pairing = this.pairings.get(pairingId);
      if (!pairing || pairing.namespace !== namespace) {
        throw new CompanionError(404, "not_found", "No such pairing");
      }
      if (pairing.ended) {
        throw new CompanionError(410, "pairing_ended", "The pairing has ended");
      }
      return pairing;
    }
    const live = [...this.pairings.values()].filter(
      p => p.namespace === namespace && !p.ended
    );
    if (live.length === 0) {
      throw new CompanionError(404, "no_pairing", "No bench is paired");
    }
    if (live.length > 1) {
      throw new CompanionError(
        400,
        "ambiguous_pairing",
        "More than one bench is paired; pass a pairing id"
      );
    }
    return live[0] as Pairing;
  }

  private isOffline(pairing: Pairing): boolean {
    if (pairing.ended) return true;
    const last = pairing.lastHeartbeatAt ?? pairing.createdAt;
    return this.now() - last > this.timing.offlineAfterMs;
  }

  private end(pairing: Pairing, reason: string): void {
    pairing.ended = { at: this.now(), reason };
    pairing.caPrivateKey = null;
    pairing.principals.clear();
  }

  /** Expire requests, end stale pairings, forget long-ended ones. */
  private sweep(): void {
    const now = this.now();
    for (const [id, r] of this.requests) {
      if (now > r.expiresAt) this.requests.delete(id);
    }
    for (const [id, p] of this.pairings) {
      if (p.ended) {
        if (now - p.ended.at > ENDED_RETENTION_MS) this.pairings.delete(id);
        continue;
      }
      const last = p.lastHeartbeatAt ?? p.createdAt;
      if (now - last > this.timing.staleAfterMs) this.end(p, "stale");
    }
  }
}

/** `HAPI_COMPANION` truthy (`1`, `true`, `yes`) turns the routes on. */
export function isCompanionEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = (env.HAPI_COMPANION ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Server timing, with test-only environment overrides. */
export function companionTimingFromEnv(
  env: Record<string, string | undefined> = process.env
): Partial<CompanionTiming> {
  const read = (name: string): number | undefined => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const timing: Partial<CompanionTiming> = {};
  const certTtlMs = read("HAPI_COMPANION_CERT_TTL_MS");
  const offlineAfterMs = read("HAPI_COMPANION_OFFLINE_AFTER_MS");
  const staleAfterMs = read("HAPI_COMPANION_STALE_AFTER_MS");
  const heartbeatIntervalMs = read("HAPI_COMPANION_HEARTBEAT_MS");
  if (certTtlMs) timing.certTtlMs = certTtlMs;
  if (offlineAfterMs) timing.offlineAfterMs = offlineAfterMs;
  if (staleAfterMs) timing.staleAfterMs = staleAfterMs;
  if (heartbeatIntervalMs) timing.heartbeatIntervalMs = heartbeatIntervalMs;
  return timing;
}
