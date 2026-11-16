// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi api sessions billable <id-or-tag> off` — the agents' one way to switch a
 * session not billable (issue #6646, Task 7c, ruling AGS-2). It lives beside
 * `api.ts` because that file is at its 1,500-line limit (the Project Manager's
 * ruling of 2026-11-13); `api.ts` only dispatches to it.
 *
 * It sends `PUT /api/sessions/<id>/billable { "billable": false }` and stamps the
 * calling session the way `hapi api sessions send` does: `X-Hapi-Session-Id` from
 * `HAPI_SESSION_ID` (a tag, which the server resolves), so the record names the
 * agent's session. From a terminal outside any session it sends no header and is
 * recorded as `client`. There is no `on` form: a session is switched on in the app.
 *
 * `/api/sessions/:id` takes the id while `HAPI_SESSION_ID` holds the tag, so the
 * argument is first looked up through `GET /cli/sessions/:tag` (which resolves an id
 * or a tag); an argument the lookup does not find (a session on another node) is
 * sent unchanged as the id.
 */
import axios from "axios";
import { configuration } from "@/configuration";
import { writeStdout } from "@/utils/stdout";
import { authenticateCli, resolveCliApiToken } from "./cliAuth";

export const SESSIONS_BILLABLE_USAGE =
  "Usage: hapi api sessions billable <id-or-tag> off";

export const SESSIONS_BILLABLE_ON_REFUSAL =
  "This command only switches a session off: hapi api sessions billable <id-or-tag> off. A session is switched on in the app.";

/** The two arguments after `billable`: the session and the word `off`, nothing else. */
export function parseSessionsBillableArgs(
  args: readonly string[]
): { ok: true; target: string } | { ok: false; error: string } {
  const [target, word, ...rest] = args;
  if (!target || !word || rest.length > 0) {
    return { ok: false, error: SESSIONS_BILLABLE_USAGE };
  }
  if (word !== "off") return { ok: false, error: SESSIONS_BILLABLE_ON_REFUSAL };
  return { ok: true, target };
}

export type SessionsBillableDeps = {
  /** The calling session's `HAPI_SESSION_ID`, when the verb runs inside a session. */
  callerTag?: string;
  /** Resolve an id or a tag to the session's id; null when this node does not know it. */
  lookup: (idOrTag: string) => Promise<string | null>;
  /** Send the write; injected so tests make no request (cli/CLAUDE.md, no module mocks). */
  put: (
    path: string,
    body: { billable: false },
    headers: Record<string, string>
  ) => Promise<unknown>;
};

/** Resolve the target, then switch it off, naming the calling session when there is one. */
export async function runSessionsBillableOff(
  target: string,
  deps: SessionsBillableDeps
): Promise<unknown> {
  const id = (await deps.lookup(target)) ?? target;
  const headers: Record<string, string> = deps.callerTag
    ? { "X-Hapi-Session-Id": deps.callerTag }
    : {};
  return deps.put(
    `/api/sessions/${encodeURIComponent(id)}/billable`,
    { billable: false },
    headers
  );
}

/** The `hapi api sessions billable` action. A server refusal reaches the caller's error print. */
export async function handleSessionsBillable(args: string[]): Promise<void> {
  const parsed = parseSessionsBillableArgs(args);
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(1);
  }
  const jwt = await authenticateCli();
  const resolution = await resolveCliApiToken();
  const cliToken =
    resolution.kind === "env" || resolution.kind === "settings"
      ? resolution.token
      : null;
  // A settings token goes only to the loopback server the URL names (no proxy,
  // no redirect), as authenticateCli sends it.
  const transport =
    resolution.kind === "settings"
      ? { proxy: false as const, maxRedirects: 0 }
      : {};
  const data = await runSessionsBillableOff(parsed.target, {
    callerTag: process.env.HAPI_SESSION_ID || undefined,
    lookup: async idOrTag => {
      if (!cliToken) return null;
      try {
        const resp = await axios.get(
          `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(idOrTag)}`,
          {
            headers: { Authorization: `Bearer ${cliToken}` },
            timeout: 10_000,
            ...transport,
          }
        );
        const id = (resp.data as { session?: { id?: unknown } } | null)?.session
          ?.id;
        return typeof id === "string" ? id : null;
      } catch {
        // Not on this node (or not answering): the argument is sent as the id.
        return null;
      }
    },
    put: async (path, body, headers) =>
      (
        await axios.put(`${configuration.serverUrl}${path}`, body, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
            ...headers,
          },
          timeout: 30_000,
        })
      ).data,
  });
  writeStdout(JSON.stringify(data, null, 2));
}
