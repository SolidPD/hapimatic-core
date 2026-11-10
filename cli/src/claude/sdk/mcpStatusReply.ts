// SPDX-License-Identifier: AGPL-3.0-only
import { classifyHostedServers, type McpServerStatus } from "@hapi/protocol";

/**
 * Issue #6171: the `mcp_status` control reply, as the status rows the UI shows.
 *
 * Measured on Claude Code 2.1.312: `response.mcpServers[]` carries each server
 * this process loaded, as `{ name, status, config: { type, url? | command? },
 * tools }`. A server denied by the session's `deniedMcpServers` is not in it, so
 * unlike `claude mcp list` this is the session's own truth. Statuses seen:
 * `connected`, `failed`, `needs-auth`, `pending`, `disabled`. A status this code
 * does not know maps to `unknown` with the raw value as `statusText`, the way
 * `parseMcpList` treats an unknown glyph.
 */
export function readMcpStatusReply(response: unknown): McpServerStatus[] {
  const data = (response as { response?: unknown } | null)?.response as
    | { mcpServers?: unknown }
    | undefined;
  if (!data || !Array.isArray(data.mcpServers)) {
    throw new Error("mcp_status returned an unexpected payload shape");
  }
  const rows: McpServerStatus[] = [];
  for (const raw of data.mcpServers) {
    const server = raw as {
      name?: unknown;
      status?: unknown;
      config?: { url?: unknown; command?: unknown } | null;
    };
    if (typeof server.name !== "string" || server.name.length === 0) continue;
    const status = typeof server.status === "string" ? server.status : "";
    const url =
      typeof server.config?.url === "string"
        ? server.config.url
        : typeof server.config?.command === "string"
          ? server.config.command
          : "";
    rows.push({ name: server.name, url, ...mapStatus(status) });
  }
  return classifyHostedServers(rows);
}

function mapStatus(
  status: string
): Pick<McpServerStatus, "status" | "statusText"> {
  switch (status) {
    case "connected":
      return { status: "connected" };
    case "failed":
      return { status: "failed", statusText: "failed" };
    case "needs-auth":
    case "needs_auth":
      return { status: "needs_auth", statusText: "needs authentication" };
    default:
      return { status: "unknown", statusText: status || "unknown" };
  }
}
