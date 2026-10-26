// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #5127: the CLI side of API keys homed on another federation node.
 *
 * A session can bind a key that lives in another node's vault
 * (`<uuid>@<homeNodeId>`, see `@hapi/protocol` apiKeyRef). This node's server
 * asks the home for it; this module asks THIS node's server, over loopback:
 *
 * - {@link resolveSharedApiKey} — the key's label, masked form and home node,
 *   for the daemon's spawn-time check and the launcher's per-launch check.
 * - {@link fetchSharedApiKeySecret} — the key itself, for the session's
 *   `apiKeyHelper`, which prints it to Claude Code and nothing else.
 *
 * Both FAIL CLOSED: a missing token, a server URL that is not loopback, a
 * network error, a non-2xx answer or a malformed body is a refusal, never a
 * throw and never a fallback. A refusal carries a code and a message only; the
 * server's response text and the key never reach a returned error.
 *
 * The request goes straight to the loopback server: no ambient proxy
 * (HTTP_PROXY has no loopback exemption, and Claude Code's environment can
 * carry one) and no redirect (which would re-send the token and the body).
 * The token is resolved the way `hapi api` resolves it (`resolveCliApiToken`),
 * which never prompts and never writes settings.json.
 */

import axios from "axios";
import { z } from "zod";
import { configuration } from "@/configuration";
import {
  isLoopbackServerUrl,
  resolveCliApiToken,
  type CliTokenResolution,
} from "@/commands/cliAuth";

export type SharedKeyRefusal = { ok: false; code: string; message: string };

export type ResolvedSharedKey = {
  ok: true;
  canonicalRef: string;
  label: string | null;
  maskedKey: string;
  homeNodeId: string;
  homeNodeLabel: string;
};

/** One POST to this node's server: the answer's status and parsed body. */
export type SharedKeyPost = (
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<{ status: number; data: unknown }>;

export interface SharedKeyClientDeps {
  /** Defaults to `configuration.serverUrl`. */
  serverUrl?: string;
  /** Defaults to `resolveCliApiToken`. */
  resolveToken?: () => Promise<CliTokenResolution>;
  /** Test seam; defaults to a proxy-free, redirect-free axios POST. */
  post?: SharedKeyPost;
  /** Defaults to 15 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const RefusalSchema = z.object({
  ok: z.literal(false),
  code: z.string().min(1).max(64),
  message: z.string().max(400),
});

/** A display string a peer chose: no control characters, bounded (it reaches
 *  the daemon log, session metadata and the UI). */
const DisplayText = z
  .string()
  .max(200)
  .transform(s =>
    Array.from(s, ch => {
      const c = ch.codePointAt(0) ?? 0;
      return c < 0x20 || (c >= 0x7f && c <= 0x9f) ? " " : ch;
    }).join("")
  );

const ResolvedSchema = z.object({
  ok: z.literal(true),
  canonicalRef: z.string().min(1).max(200),
  label: DisplayText.nullable(),
  // The one masking rule (`maskApiKey`): dots plus at most the last 4.
  maskedKey: z.string().regex(/^••••[\x21-\x7e]{0,4}$/),
  homeNodeId: z.string().min(1).max(64),
  homeNodeLabel: DisplayText,
});

const SecretSchema = z.object({
  ok: z.literal(true),
  // Printable ASCII only: it is written verbatim to Claude Code's stdin.
  apiKey: z.string().regex(/^[\x21-\x7e]{1,4096}$/),
});

const refuse = (code: string, message: string): SharedKeyRefusal => ({
  ok: false,
  code,
  message,
});

const defaultPost: SharedKeyPost = async (url, body, headers, timeoutMs) => {
  const res = await axios.post(url, body, {
    headers,
    timeout: timeoutMs,
    proxy: false,
    maxRedirects: 0,
    // Every status is an answer to read, not an exception to rethrow.
    validateStatus: () => true,
  });
  return { status: res.status, data: res.data };
};

async function callServer<T>(
  path: string,
  body: unknown,
  ok: {
    safeParse(v: unknown): { success: true; data: T } | { success: false };
  },
  deps: SharedKeyClientDeps
): Promise<T | SharedKeyRefusal> {
  const serverUrl = deps.serverUrl ?? configuration.serverUrl;
  if (!isLoopbackServerUrl(serverUrl)) {
    return refuse(
      "remote_server",
      "Keys from other nodes are fetched only through this host's own server"
    );
  }
  let token: string;
  try {
    const resolution = await (deps.resolveToken ?? resolveCliApiToken)();
    if (resolution.kind !== "env" && resolution.kind !== "settings") {
      return refuse(
        "no_token",
        "This host's CLI token is not available, so the key cannot be fetched"
      );
    }
    token = resolution.token;
  } catch {
    return refuse(
      "no_token",
      "This host's CLI token is not available, so the key cannot be fetched"
    );
  }
  let answer: { status: number; data: unknown };
  try {
    answer = await (deps.post ?? defaultPost)(
      `${serverUrl}${path}`,
      body,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  } catch {
    return refuse(
      "server_unreachable",
      "This host's Hapimatic server did not answer"
    );
  }
  const refusal = RefusalSchema.safeParse(answer.data);
  if (refusal.success) {
    return refuse(refusal.data.code, refusal.data.message);
  }
  if (answer.status < 200 || answer.status >= 300) {
    return refuse(
      "server_error",
      `This host's Hapimatic server answered ${answer.status}`
    );
  }
  const parsed = ok.safeParse(answer.data);
  if (!parsed.success) {
    return refuse(
      "server_error",
      "This host's Hapimatic server sent an unexpected answer"
    );
  }
  return parsed.data;
}

/**
 * The identity of a key homed on another node (no secret). `sessionId` (the
 * session tag the check is for) is recorded in the home's audit log.
 */
export async function resolveSharedApiKey(
  input: { ref: string; expectedMasked?: string; sessionId?: string },
  deps: SharedKeyClientDeps = {}
): Promise<ResolvedSharedKey | SharedKeyRefusal> {
  return callServer(
    "/cli/api-keys/resolve",
    {
      ref: input.ref,
      ...(input.expectedMasked !== undefined
        ? { expectedMasked: input.expectedMasked }
        : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    ResolvedSchema,
    deps
  );
}

/** The secret of a key homed on another node, for the session bound to it. */
export async function fetchSharedApiKeySecret(
  input: { ref: string; expectedMasked: string; sessionId: string },
  deps: SharedKeyClientDeps = {}
): Promise<{ ok: true; apiKey: string } | SharedKeyRefusal> {
  return callServer(
    "/cli/api-keys/secret",
    {
      ref: input.ref,
      expectedMasked: input.expectedMasked,
      sessionId: input.sessionId,
    },
    SecretSchema,
    deps
  );
}
