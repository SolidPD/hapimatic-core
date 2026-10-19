// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The bench helper's HTTP client to the VM's Hapimatic server (issue #4352).
 *
 * The CA public key travels over this channel, so it must be authenticated:
 * `https` with normal certificate verification, or plain `http` only when every
 * address the host resolves to is on the tailnet (WireGuard authenticates both
 * peers) or loopback. Design doc: "Pairing and control protocol" → "Transport".
 */
import { lookup } from "node:dns/promises";
import {
  CompanionClaimResultSchema,
  CompanionHeartbeatResultSchema,
  CompanionPairRequestCreatedSchema,
  isLoopbackAddress,
  isTailnetAddress,
  type CompanionClaimResult,
  type CompanionHeartbeat,
  type CompanionHeartbeatResult,
  type CompanionPairRequestCreate,
  type CompanionPairRequestCreated,
} from "@hapi/protocol/companion";
import { trimTrailingChars } from "@hapi/protocol/trimChars";

export type ServerUrlCheck =
  | { ok: true; url: string }
  | { ok: false; message: string };

type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async host =>
  (await lookup(host, { all: true })).map(a => a.address);

/** Validate `--server`. Returns the URL without a trailing slash. */
export async function checkServerUrl(
  raw: string,
  resolve: Resolver = defaultResolver
): Promise<ServerUrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `Not a URL: ${raw}` };
  }
  const base = `${url.protocol}//${url.host}${trimTrailingChars(url.pathname, "/")}`;
  if (url.protocol === "https:") return { ok: true, url: base };
  if (url.protocol !== "http:") {
    return { ok: false, message: "--server must be an http(s) URL" };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, message: `Cannot resolve ${host}` };
  }
  const safe =
    addresses.length > 0 &&
    addresses.every(a => isTailnetAddress(a) || isLoopbackAddress(a));
  if (!safe) {
    return {
      ok: false,
      message: `Plain http is allowed only to a tailnet or loopback address; ${host} resolves to ${addresses.join(", ") || "nothing"}. Use the VM's tailnet name or its https URL.`,
    };
  }
  return { ok: true, url: base };
}

/** A non-2xx answer from the server, with its machine-readable code. */
export class CompanionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "CompanionHttpError";
  }
}

export class HelperClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 8000
  ) {}

  private async post(
    path: string,
    body: unknown,
    token?: string
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const p = (payload ?? {}) as { error?: unknown; message?: unknown };
      throw new CompanionHttpError(
        res.status,
        typeof p.error === "string" ? p.error : `http_${res.status}`,
        typeof p.message === "string" ? p.message : `HTTP ${res.status}`
      );
    }
    return payload;
  }

  async createPairRequest(
    input: CompanionPairRequestCreate
  ): Promise<CompanionPairRequestCreated> {
    return CompanionPairRequestCreatedSchema.parse(
      await this.post("/api/companion/helper/pair-requests", input)
    );
  }

  async claim(
    requestId: string,
    pollSecret: string
  ): Promise<CompanionClaimResult> {
    return CompanionClaimResultSchema.parse(
      await this.post(
        `/api/companion/helper/pair-requests/${encodeURIComponent(requestId)}/claim`,
        { pollSecret }
      )
    );
  }

  async heartbeat(
    token: string,
    report: CompanionHeartbeat
  ): Promise<CompanionHeartbeatResult> {
    return CompanionHeartbeatResultSchema.parse(
      await this.post("/api/companion/helper/heartbeat", report, token)
    );
  }

  async end(token: string): Promise<void> {
    await this.post("/api/companion/helper/end", {}, token);
  }
}
