// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/** The 400 body a malformed JSON request body gets (the `apiKeys.ts` shape). */
export const INVALID_JSON_BODY = "Invalid JSON body";

/**
 * `c.req.json()` that answers a malformed body with `400 { error: "Invalid JSON
 * body" }` instead of a generic 500 (issue #4056 R6). It throws an
 * `HTTPException`, so a call site stays one line: `app.onError` answers it with
 * `err.getResponse()`, and a route-level app with no `onError` gets the same
 * response from Hono's default handler. Like `c.req.json<T>()`, `T` is a
 * statement about the body, not a check: validate it before trusting it.
 */
export async function readJsonBody<T = unknown>(c: Context): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HTTPException(400, {
      message: INVALID_JSON_BODY,
      res: Response.json({ error: INVALID_JSON_BODY }, { status: 400 }),
    });
  }
}
