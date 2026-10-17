// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local hardware companion — wire schemas and OpenSSH encodings (issue #4352).
 *
 * Shared by the pairing service on the server (`server/src/services/
 * companionPairingService.ts`) and by `hapi companion` in the CLI. Design:
 * `docs/internal/architecture/hardware-companion.md`.
 *
 * Everything here is pure: no `node:` imports, no `process.env`. Key generation
 * and signing are the callers' job (they hold `node:crypto`); this module only
 * encodes and decodes the OpenSSH wire formats (RFC 4251 `string`/`uint32`/
 * `uint64`, `PROTOCOL.key` and `PROTOCOL.certkeys`) and computes fingerprints
 * through Web Crypto, which both Bun and browsers provide.
 */
import { z } from "zod";

// ── Constants ────────────────────────────────────────────────────────────────

/** Prefix of a pairing-scoped bearer token. The JWT middleware refuses it. */
export const COMPANION_TOKEN_PREFIX = "hcp_";

/** Every certificate principal starts with this, followed by the session id. */
export const COMPANION_PRINCIPAL_PREFIX = "hapi-session-";

/** Timing the server hands the helper at claim time (milliseconds). */
export const CompanionTimingSchema = z.object({
  heartbeatIntervalMs: z.number().int().positive(),
  certTtlMs: z.number().int().positive(),
  offlineAfterMs: z.number().int().positive(),
  staleAfterMs: z.number().int().positive(),
});
export type CompanionTiming = z.infer<typeof CompanionTimingSchema>;

export const DEFAULT_COMPANION_TIMING: CompanionTiming = {
  heartbeatIntervalMs: 10_000,
  certTtlMs: 5 * 60_000,
  offlineAfterMs: 30_000,
  staleAfterMs: 120_000,
};

/**
 * The principal for a cloud session. Session ids are server-generated, but the
 * principal is written into an `sshd` `AuthorizedPrincipalsFile`, so anything
 * outside `[A-Za-z0-9._-]` is replaced and the length is capped.
 */
export function principalForSession(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return `${COMPANION_PRINCIPAL_PREFIX}${safe}`;
}

/** True for a principal this protocol could have produced. */
export function isCompanionPrincipal(value: string): boolean {
  return /^hapi-session-[A-Za-z0-9._-]{1,80}$/.test(value);
}

// ── Pairing codes (Crockford base32) ─────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** An 8-character Crockford base32 code from 5 random bytes (40 bits). */
export function encodePairingCode(random5: Uint8Array): string {
  if (random5.length < 5) throw new Error("pairing code needs 5 random bytes");
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(random5[i] ?? 0);
  let out = "";
  for (let i = 7; i >= 0; i--) {
    out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return out;
}

/**
 * Normalize what a person typed: upper-case, drop separators, and map the
 * Crockford look-alikes (`O`→`0`, `I`/`L`→`1`). Returns `null` for anything
 * that is not 8 Crockford characters afterwards.
 */
export function normalizePairingCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== 8) return null;
  for (const ch of cleaned) if (!CROCKFORD.includes(ch)) return null;
  return cleaned;
}

/** `ABCD1234` → `ABCD-1234` for display. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// ── Base64 ────────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

// ── SSH wire encoding ─────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();

/** Builds an RFC 4251 byte sequence. */
export class SshWriter {
  private readonly parts: Uint8Array[] = [];

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  uint32(value: number): this {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value >>> 0);
    return this.raw(buf);
  }

  uint64(value: bigint | number): this {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt(value));
    return this.raw(buf);
  }

  string(value: Uint8Array | string): this {
    const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
    this.uint32(bytes.length);
    return this.raw(bytes);
  }

  toBytes(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of this.parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
}

/** Reads an RFC 4251 byte sequence; throws on truncation. */
export class SshReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  uint32(): number {
    if (this.offset + 4 > this.bytes.length) throw new Error("ssh: truncated");
    const v = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      4
    ).getUint32(0);
    this.offset += 4;
    return v;
  }

  uint64(): bigint {
    if (this.offset + 8 > this.bytes.length) throw new Error("ssh: truncated");
    const v = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset + this.offset,
      8
    ).getBigUint64(0);
    this.offset += 8;
    return v;
  }

  string(): Uint8Array {
    const len = this.uint32();
    if (this.offset + len > this.bytes.length) {
      throw new Error("ssh: truncated");
    }
    const v = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return v;
  }

  text(): string {
    return new TextDecoder().decode(this.string());
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }
}

const ED25519 = "ssh-ed25519";
const ED25519_CERT = "ssh-ed25519-cert-v01@openssh.com";

/** The `ssh-ed25519` public-key blob for a raw 32-byte key. */
export function ed25519PublicKeyBlob(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new Error("ed25519 key must be 32 bytes");
  return new SshWriter().string(ED25519).string(publicKey).toBytes();
}

/** `ssh-ed25519 <base64> [comment]`. */
export function formatEd25519PublicKey(
  publicKey: Uint8Array,
  comment?: string
): string {
  const line = `${ED25519} ${bytesToBase64(ed25519PublicKeyBlob(publicKey))}`;
  return comment ? `${line} ${comment}` : line;
}

/**
 * Parse an `ssh-ed25519 <base64> [comment]` line into its raw 32-byte key.
 * Throws for any other key type or a malformed blob.
 */
export function parseEd25519PublicKey(line: string): Uint8Array {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== ED25519 || !b64) {
    throw new Error("expected an ssh-ed25519 public key");
  }
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(b64);
  } catch {
    throw new Error("public key is not valid base64");
  }
  const reader = new SshReader(blob);
  if (reader.text() !== ED25519) {
    throw new Error("public key blob type mismatch");
  }
  const key = reader.string();
  if (key.length !== 32 || !reader.done()) {
    throw new Error("malformed ed25519 public key");
  }
  return key;
}

/** `SHA256:<unpadded base64>` — the fingerprint `ssh-keygen -l` prints. */
export async function sshFingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(blob))
  );
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
}

/** Fingerprint of an `ssh-ed25519` public-key line. */
export async function ed25519LineFingerprint(line: string): Promise<string> {
  return sshFingerprint(ed25519PublicKeyBlob(parseEd25519PublicKey(line)));
}

/**
 * An unencrypted OpenSSH private key file (`PROTOCOL.key`, `openssh-key-v1`)
 * for an Ed25519 key. `checkInt` is any 32-bit value; it only lets a reader
 * detect a wrong passphrase, and there is no passphrase here.
 */
export function formatOpenSshEd25519PrivateKey(
  seed: Uint8Array,
  publicKey: Uint8Array,
  checkInt: number,
  comment = ""
): string {
  if (seed.length !== 32 || publicKey.length !== 32) {
    throw new Error("ed25519 seed and public key must be 32 bytes");
  }
  const privateKey = new Uint8Array(64);
  privateKey.set(seed, 0);
  privateKey.set(publicKey, 32);
  const section = new SshWriter()
    .uint32(checkInt)
    .uint32(checkInt)
    .string(ED25519)
    .string(publicKey)
    .string(privateKey)
    .string(comment);
  const unpaddedLength = section.toBytes().length;
  const padLength = (8 - (unpaddedLength % 8)) % 8;
  const padding = new Uint8Array(padLength);
  for (let i = 0; i < padLength; i++) padding[i] = i + 1;
  section.raw(padding);
  const body = new SshWriter()
    .raw(textEncoder.encode("openssh-key-v1\0"))
    .string("none")
    .string("none")
    .string(new Uint8Array(0))
    .uint32(1)
    .string(ed25519PublicKeyBlob(publicKey))
    .string(section.toBytes())
    .toBytes();
  const b64 = bytesToBase64(body);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 70) lines.push(b64.slice(i, i + 70));
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

export type UserCertificateInput = {
  /** The user's raw 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
  /** The CA's raw 32-byte Ed25519 public key. */
  caPublicKey: Uint8Array;
  /** Signs the certificate body with the CA's private key (raw 64-byte signature). */
  sign: (data: Uint8Array) => Uint8Array;
  nonce: Uint8Array;
  serial: bigint | number;
  keyId: string;
  principals: string[];
  /** Seconds since the epoch. */
  validAfter: number;
  /** Seconds since the epoch. */
  validBefore: number;
  comment?: string;
};

/**
 * Extensions granted to every companion certificate, in the lexical order
 * `PROTOCOL.certkeys` requires. A PTY and port forwarding only: agent and X11
 * forwarding and `~/.ssh/rc` execution are not granted.
 */
export const COMPANION_CERT_EXTENSIONS = [
  "permit-port-forwarding",
  "permit-pty",
] as const;

/**
 * An `ssh-ed25519-cert-v01@openssh.com` user certificate line, signed with
 * `input.sign` (`PROTOCOL.certkeys`). No critical options are set.
 */
export function signEd25519UserCertificate(
  input: UserCertificateInput
): string {
  if (input.nonce.length < 16) throw new Error("certificate nonce too short");
  if (input.principals.length === 0) throw new Error("no principals");
  const principals = new SshWriter();
  for (const p of input.principals) principals.string(p);
  const extensions = new SshWriter();
  for (const name of COMPANION_CERT_EXTENSIONS) {
    extensions.string(name).string(new Uint8Array(0));
  }
  const body = new SshWriter()
    .string(ED25519_CERT)
    .string(input.nonce)
    .string(input.publicKey)
    .uint64(input.serial)
    .uint32(1) // SSH_CERT_TYPE_USER
    .string(input.keyId)
    .string(principals.toBytes())
    .uint64(input.validAfter)
    .uint64(input.validBefore)
    .string(new Uint8Array(0)) // critical options
    .string(extensions.toBytes())
    .string(new Uint8Array(0)) // reserved
    .string(ed25519PublicKeyBlob(input.caPublicKey))
    .toBytes();
  const signature = input.sign(body);
  if (signature.length !== 64) {
    throw new Error("ed25519 signature must be 64 bytes");
  }
  const blob = new SshWriter()
    .raw(body)
    .string(new SshWriter().string(ED25519).string(signature).toBytes())
    .toBytes();
  const line = `${ED25519_CERT} ${bytesToBase64(blob)}`;
  return input.comment ? `${line} ${input.comment}` : line;
}

export type ParsedUserCertificate = {
  publicKey: Uint8Array;
  serial: bigint;
  type: number;
  keyId: string;
  principals: string[];
  validAfter: bigint;
  validBefore: bigint;
  extensions: string[];
  caPublicKey: Uint8Array;
  /** The bytes the signature covers. */
  signedData: Uint8Array;
  signature: Uint8Array;
};

/** Decode a certificate line produced by {@link signEd25519UserCertificate}. */
export function parseEd25519UserCertificate(
  line: string
): ParsedUserCertificate {
  const [type, b64] = line.trim().split(/\s+/);
  if (type !== ED25519_CERT || !b64) {
    throw new Error("expected an ed25519 certificate");
  }
  const blob = base64ToBytes(b64);
  const r = new SshReader(blob);
  if (r.text() !== ED25519_CERT) {
    throw new Error("certificate blob type mismatch");
  }
  r.string(); // nonce
  const publicKey = r.string();
  const serial = r.uint64();
  const certType = r.uint32();
  const keyId = r.text();
  const principalsReader = new SshReader(r.string());
  const principals: string[] = [];
  while (!principalsReader.done()) principals.push(principalsReader.text());
  const validAfter = r.uint64();
  const validBefore = r.uint64();
  r.string(); // critical options
  const extReader = new SshReader(r.string());
  const extensions: string[] = [];
  while (!extReader.done()) {
    extensions.push(extReader.text());
    extReader.string();
  }
  r.string(); // reserved
  const caReader = new SshReader(r.string());
  if (caReader.text() !== ED25519) throw new Error("CA key type mismatch");
  const caPublicKey = caReader.string();
  const sigField = r.string();
  if (!r.done()) throw new Error("trailing bytes after certificate");
  // Everything before the signature field (its 4-byte length + contents) is signed.
  const signedData = blob.slice(0, blob.length - 4 - sigField.length);
  const sigReader = new SshReader(sigField);
  if (sigReader.text() !== ED25519) throw new Error("signature type mismatch");
  const signature = sigReader.string();
  return {
    publicKey,
    serial,
    type: certType,
    keyId,
    principals,
    validAfter,
    validBefore,
    extensions,
    caPublicKey,
    signedData,
    signature,
  };
}

// ── Address classification ───────────────────────────────────────────────────

/** True for a Tailscale address: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(address: string): boolean {
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 100 && b >= 64 && b <= 127;
  }
  // Fully anchored: the value reaches `sshd_config` and the client's HostName.
  return /^fd7a:115c:a1e0(:[0-9a-f]{0,4}){1,5}$/i.test(address);
}

/** True for 127.0.0.0/8 and ::1. */
export function isLoopbackAddress(address: string): boolean {
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) return true;
  return address === "::1";
}

// ── Wire schemas ──────────────────────────────────────────────────────────────

const shortText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    .regex(/^[^\u0000-\u001f\u007f]*$/, "control characters are not allowed");

export const CompanionPrivilegeSchema = z.enum(["user", "admin"]);
export type CompanionPrivilege = z.infer<typeof CompanionPrivilegeSchema>;

/** Helper → server: open a pairing request. */
export const CompanionPairRequestCreateSchema = z.object({
  hostKey: shortText(200),
  localUser: z.string().regex(/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/),
  hostname: shortText(253),
  os: shortText(32),
  arch: shortText(32),
  privilege: CompanionPrivilegeSchema,
  // The server repeats the helper's own check: the route is unauthenticated,
  // and this value becomes the VM client's HostName.
  listenAddress: shortText(64).refine(
    a => isTailnetAddress(a) || isLoopbackAddress(a),
    "listenAddress must be a tailnet or loopback address"
  ),
});
export type CompanionPairRequestCreate = z.infer<
  typeof CompanionPairRequestCreateSchema
>;

export const CompanionPairRequestCreatedSchema = z.object({
  requestId: z.string(),
  code: z.string(),
  pollSecret: z.string(),
  expiresAt: z.number(),
  hostKeyFingerprint: z.string(),
});
export type CompanionPairRequestCreated = z.infer<
  typeof CompanionPairRequestCreatedSchema
>;

export const CompanionClaimSchema = z.object({
  pollSecret: z.string().min(1).max(200),
});

export const CompanionClaimResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), expiresAt: z.number() }),
  z.object({
    status: z.literal("paired"),
    pairingId: z.string(),
    token: z.string(),
    caPublicKey: z.string(),
    caFingerprint: z.string(),
    hostKeyFingerprint: z.string(),
    timing: CompanionTimingSchema,
    serverTime: z.number(),
  }),
]);
export type CompanionClaimResult = z.infer<typeof CompanionClaimResultSchema>;

/** One `sshd` instance the helper runs, as reported in a heartbeat. */
export const CompanionInstanceReportSchema = z.object({
  principal: z.string().max(100),
  port: z.number().int().min(1024).max(65535),
  liveConnections: z.number().int().min(0).max(10_000),
  sources: z.array(z.string().max(64)).max(8),
});
export type CompanionInstanceReport = z.infer<
  typeof CompanionInstanceReportSchema
>;

export const CompanionDecisionSchema = z.object({
  principal: z.string().max(100),
  decision: z.enum(["approve", "deny"]),
});
export type CompanionDecision = z.infer<typeof CompanionDecisionSchema>;

/** Helper → server, every `heartbeatIntervalMs`. */
export const CompanionHeartbeatSchema = z.object({
  instances: z.array(CompanionInstanceReportSchema).max(32).default([]),
  decisions: z.array(CompanionDecisionSchema).max(32).default([]),
});
export type CompanionHeartbeat = z.infer<typeof CompanionHeartbeatSchema>;

/** A principal the bench should know about. */
export const CompanionPrincipalViewSchema = z.object({
  principal: z.string(),
  sessionLabel: z.string(),
  state: z.enum(["requested", "approved"]),
  validUntil: z.number().nullable(),
});
export type CompanionPrincipalView = z.infer<
  typeof CompanionPrincipalViewSchema
>;

export const CompanionHeartbeatResultSchema = z.object({
  serverTime: z.number(),
  principals: z.array(CompanionPrincipalViewSchema),
});
export type CompanionHeartbeatResult = z.infer<
  typeof CompanionHeartbeatResultSchema
>;

/** VM client → server: look up or confirm a code shown on the bench. */
export const CompanionCodeLookupSchema = z.object({
  code: z.string().min(1).max(20),
});

export const CompanionCodeConfirmSchema = z.object({
  code: z.string().min(1).max(20),
  hostKeyFingerprint: z.string().min(1).max(100),
});

export const CompanionPairRequestInfoSchema = z.object({
  requestId: z.string(),
  hostname: z.string(),
  localUser: z.string(),
  os: z.string(),
  arch: z.string(),
  privilege: CompanionPrivilegeSchema,
  listenAddress: z.string(),
  hostKeyFingerprint: z.string(),
  expiresAt: z.number(),
});
export type CompanionPairRequestInfo = z.infer<
  typeof CompanionPairRequestInfoSchema
>;

export const CompanionConfirmResultSchema = z.object({
  pairingId: z.string(),
  caFingerprint: z.string(),
  hostKeyFingerprint: z.string(),
});
export type CompanionConfirmResult = z.infer<
  typeof CompanionConfirmResultSchema
>;

export const CompanionPairingStateSchema = z.enum(["live", "offline", "ended"]);

export const CompanionPairingSummarySchema = z.object({
  pairingId: z.string(),
  state: CompanionPairingStateSchema,
  hostname: z.string(),
  localUser: z.string(),
  os: z.string(),
  arch: z.string(),
  privilege: CompanionPrivilegeSchema,
  listenAddress: z.string(),
  hostKeyFingerprint: z.string(),
  caFingerprint: z.string(),
  createdAt: z.number(),
  lastHeartbeatAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: z.string().nullable(),
  principals: z.array(
    z.object({
      principal: z.string(),
      sessionId: z.string(),
      sessionLabel: z.string(),
      state: z.enum(["requested", "approved", "denied"]),
      validUntil: z.number().nullable(),
      port: z.number().nullable(),
      liveConnections: z.number(),
      sources: z.array(z.string()),
    })
  ),
});
export type CompanionPairingSummary = z.infer<
  typeof CompanionPairingSummarySchema
>;

export const CompanionPairingsListSchema = z.object({
  pairings: z.array(CompanionPairingSummarySchema),
  pending: z.array(
    z.object({
      requestId: z.string(),
      hostname: z.string(),
      localUser: z.string(),
      expiresAt: z.number(),
    })
  ),
});
export type CompanionPairingsList = z.infer<typeof CompanionPairingsListSchema>;

/** VM client → server: a certificate for a cloud session's key. */
export const CompanionCertificateRequestSchema = z.object({
  pairingId: z.string().max(64).optional(),
  session: z.string().min(1).max(128),
  publicKey: z.string().min(1).max(200),
});
export type CompanionCertificateRequest = z.infer<
  typeof CompanionCertificateRequestSchema
>;

export const CompanionCertificateResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("requested"),
    pairingId: z.string(),
    principal: z.string(),
  }),
  z.object({
    state: z.literal("denied"),
    pairingId: z.string(),
    principal: z.string(),
  }),
  z.object({
    state: z.literal("approved"),
    pairingId: z.string(),
    principal: z.string(),
    certificate: z.string(),
    validBefore: z.number(),
    host: z.string(),
    port: z.number(),
    user: z.string(),
    hostKey: z.string(),
  }),
]);
export type CompanionCertificateResult = z.infer<
  typeof CompanionCertificateResultSchema
>;
