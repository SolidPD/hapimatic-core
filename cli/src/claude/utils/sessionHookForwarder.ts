// SPDX-License-Identifier: AGPL-3.0-only
import { request } from "node:http";

import { writeStdout } from "@/utils/stdout";

function logError(message: string, error?: unknown): void {
  const detail =
    error instanceof Error ? error.message : error ? String(error) : "";
  const suffix = detail ? `: ${detail}` : "";
  process.stderr.write(`[hook-forwarder] ${message}${suffix}\n`);
}

/** The forwarder's own bound on one hook request (#6455). */
export const FORWARD_TIMEOUT_MS = 15_000;

/**
 * The hook server's answer Claude Code should read, or null (#6455). Only a Stop
 * hook's JSON decision is relayed: Claude Code adds the plain stdout of a
 * `UserPromptSubmit` or `SessionStart` hook to the agent's context, so anything
 * else printed here would leak into the conversation. An older hook server
 * answers `text/plain ok`, which is never relayed, so a version skew either way
 * blocks nothing.
 */
export function relayableDecision(
  forwarded: Buffer,
  status: number | undefined,
  contentType: string | undefined,
  response: Buffer
): string | null {
  if (status !== 200) return null;
  if (!contentType?.toLowerCase().startsWith("application/json")) return null;
  try {
    const input = JSON.parse(forwarded.toString("utf-8")) as {
      hook_event_name?: unknown;
    } | null;
    if (input?.hook_event_name !== "Stop") return null;
    const text = response.toString("utf-8");
    const parsed = JSON.parse(text) as { decision?: unknown } | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed.decision !== "block" && parsed.decision !== "approve")
    ) {
      return null;
    }
    return text;
  } catch {
    return null;
  }
}

function parsePort(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return port;
}

function parseArgs(args: string[]): {
  port: number | null;
  token: string | null;
} {
  let port: number | null = null;
  let token: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      port = parsePort(args[i + 1]);
      i += 1;
      continue;
    }

    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }

    if (arg === "--token" || arg === "-t") {
      token = args[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }

    if (!port) {
      port = parsePort(arg);
      continue;
    }

    if (!token) {
      token = arg;
    }
  }

  return { port, token };
}

export async function runSessionHookForwarder(
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<void> {
  const { port, token } = parseArgs(args);
  if (!port) {
    logError("Invalid or missing port argument");
    process.exitCode = 1;
    return;
  }

  if (!token) {
    logError("Missing hook token");
    process.exitCode = 1;
    return;
  }

  try {
    const chunks: Buffer[] = [];
    process.stdin.resume();
    for await (const chunk of process.stdin) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(chunk as Buffer);
      }
    }

    const body = Buffer.concat(chunks);

    let hadError = false;
    let decision: string | null = null;
    await new Promise<void>(resolve => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/hook/session-start",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            "x-hapi-hook-token": token,
          },
        },
        res => {
          if (res.statusCode && res.statusCode >= 400) {
            hadError = true;
            logError(`Hook server responded with status ${res.statusCode}`);
          }
          const parts: Buffer[] = [];
          res.on("data", (chunk: Buffer) => parts.push(chunk));
          res.on("error", error => {
            hadError = true;
            logError("Error reading hook server response", error);
            resolve();
          });
          // A response cut off mid-body ends in "close" without "end".
          res.on("close", () => resolve());
          res.on("end", () => {
            decision = relayableDecision(
              body,
              res.statusCode,
              res.headers["content-type"],
              Buffer.concat(parts)
            );
            resolve();
          });
        }
      );

      // #6455: the hook server answers within its own bounds; this only stops a
      // hung server from holding Claude's hook. A failing Stop hook never blocks.
      req.setTimeout(options.timeoutMs ?? FORWARD_TIMEOUT_MS, () => {
        req.destroy(new Error("hook server did not answer in time"));
      });
      req.on("error", error => {
        hadError = true;
        logError("Failed to send hook request", error);
        resolve();
      });
      req.end(body);
    });
    if (decision !== null) {
      // Synchronous and complete, so the process cannot exit before Claude Code
      // has the whole decision (#3450).
      writeStdout(decision);
    }
    if (hadError) {
      process.exitCode = 1;
    }
  } catch (error) {
    logError("Failed to forward session hook", error);
    process.exitCode = 1;
  }
}
