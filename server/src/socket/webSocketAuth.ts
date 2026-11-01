// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web-socket token verification for the browser namespaces (`/terminal`,
 * `/claude-pty`). Extracted from `socket/server.ts`, where both namespaces
 * carried an identical inline copy (issue #5444, decision D10).
 *
 * Accepts only an HS256 `{uid, ns}` JWT signed with the server's secret — the
 * same secret and payload shape as `web/middleware/auth.ts`. Prefixed bearer
 * credentials that are valid on narrower surfaces are refused by name before
 * any JWT verification: a companion pairing token (`hcp_`, #4352) and the
 * monitoring sweep's read-only health token (`hhr_`, #5444). Refusing them
 * here means neither can ever open a terminal, even if a future change made
 * such tokens verify as a JWT.
 *
 * The error strings are part of the socket contract and are unchanged from the
 * inline copies: "Missing token", "Invalid token payload", "Invalid token".
 */
import { jwtVerify } from "jose";
import { z } from "zod";
import { COMPANION_TOKEN_PREFIX } from "@hapi/protocol/companion";
import { HEALTH_READ_TOKEN_PREFIX } from "../config/healthReadToken";

const jwtPayloadSchema = z.object({
  uid: z.number(),
  ns: z.string(),
});

export type WebSocketTokenResult =
  | { ok: true; uid: number; ns: string }
  | {
      ok: false;
      error: "Missing token" | "Invalid token payload" | "Invalid token";
    };

export async function verifyWebSocketToken(
  token: unknown,
  jwtSecret: Uint8Array
): Promise<WebSocketTokenResult> {
  if (typeof token !== "string" || token === "") {
    return { ok: false, error: "Missing token" };
  }
  if (
    token.startsWith(COMPANION_TOKEN_PREFIX) ||
    token.startsWith(HEALTH_READ_TOKEN_PREFIX)
  ) {
    return { ok: false, error: "Invalid token" };
  }
  try {
    const verified = await jwtVerify(token, jwtSecret, {
      algorithms: ["HS256"],
    });
    const parsed = jwtPayloadSchema.safeParse(verified.payload);
    if (!parsed.success) {
      return { ok: false, error: "Invalid token payload" };
    }
    return { ok: true, uid: parsed.data.uid, ns: parsed.data.ns };
  } catch {
    return { ok: false, error: "Invalid token" };
  }
}
