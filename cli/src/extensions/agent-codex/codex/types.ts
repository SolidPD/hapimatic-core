// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Type definitions for Codex MCP integration
 */

import { stripVTControlCharacters } from "node:util";

export interface CodexSessionConfig {
  prompt: string;
  "approval-policy"?: "untrusted" | "on-request" | "never";
  "base-instructions"?: string;
  config?: Record<string, unknown>;
  cwd?: string;
  "include-plan-tool"?: boolean;
  model?: string;
  profile?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface CodexToolResponse {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: unknown;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Event delivered to the remote launcher's handler. The MCP transport receives
 * these as `codex/event` notifications; the app-server transport's converter
 * emits the same shapes (#6263).
 */
export interface CodexEvent {
  type?: string;
  session_id?: string;
  sessionId?: string;
  conversation_id?: string;
  conversationId?: string;
  // codex mcp-server >= 0.144.6 identifies the session by threadId
  thread_id?: string;
  threadId?: string;
  // agent_message
  message?: string;
  // agent_reasoning / agent_reasoning_delta
  text?: string;
  delta?: string;
  // exec_command_begin / exec_command_end / exec_approval_request
  command?: string;
  output?: string;
  error?: string;
  call_id?: string;
  // patch_apply_begin
  auto_approved?: boolean;
  changes?: Record<string, unknown>;
  // patch_apply_end
  stdout?: string;
  stderr?: string;
  success?: boolean;
  // turn_diff
  unified_diff?: string;
  // task_started / task_complete / turn_aborted / task_failed (app-server)
  turn_id?: string;
  data?: {
    session_id?: string;
    sessionId?: string;
    conversation_id?: string;
    conversationId?: string;
    thread_id?: string;
    threadId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Why a Codex transport could not start (#6263 R4). */
export type CodexStartErrorKind =
  | "not-installed"
  | "exited-at-startup"
  | "initialize-failed";

/**
 * A Codex transport failed to start: the binary is missing, the child exited
 * before the handshake finished, or the handshake failed. The launcher turns
 * it into a chat message, and `runCodex` into the archive reason.
 */
export class CodexStartError extends Error {
  readonly kind: CodexStartErrorKind;
  readonly transport: "mcp" | "app-server";
  readonly codexVersion: string | null;
  readonly codexBin: string;
  readonly detail: string;
  /** The first, failed attempt when this error is the fallback's (#6263 R3). */
  previous: CodexStartError | null = null;
  /** Set by the launcher: the cause as shown to the user, without the prefix. */
  summary: string | null = null;

  constructor(args: {
    kind: CodexStartErrorKind;
    transport: "mcp" | "app-server";
    codexVersion: string | null;
    codexBin: string;
    detail: string;
    cause?: unknown;
  }) {
    super(
      `Codex ${args.transport} transport failed to start (${args.kind}): ${args.detail}`,
      args.cause === undefined ? undefined : { cause: args.cause }
    );
    this.name = "CodexStartError";
    this.kind = args.kind;
    this.transport = args.transport;
    this.codexVersion = args.codexVersion;
    this.codexBin = args.codexBin;
    this.detail = args.detail;
  }
}

/** Lines of a Codex child's stderr each client keeps for its failure messages. */
export const STDERR_TAIL_LINES = 20;

/**
 * Append a Codex child's stderr chunk to a bounded tail and return the lines
 * kept, which the caller logs under its own label (#6263). Codex colours its
 * tracing output even on a pipe (0.167.0), so the escape codes are stripped
 * before a line can reach a chat message; blank lines are dropped.
 */
export function appendStderrTail(tail: string[], chunk: string): string[] {
  const kept: string[] = [];
  for (const line of chunk.split("\n")) {
    const text = stripVTControlCharacters(line).trim();
    if (text.length === 0) continue;
    kept.push(text);
    tail.push(text);
    if (tail.length > STDERR_TAIL_LINES) tail.shift();
  }
  return kept;
}

/**
 * The cause in a Codex child's stderr: the first line that is not a Codex
 * `WARNING:` (Codex prints one, e.g. "could not create PATH aliases", before
 * any error), joined with the next when it is a Rust panic header
 * (`thread 'main' panicked at file:line:col:`), whose message follows on the
 * next line. Falls back to the first line when every line is a warning.
 */
export function stderrCause(lines: readonly string[]): string | undefined {
  const index = lines.findIndex(line => !/^WARNING:/.test(line));
  if (index === -1) return lines[0];
  const first = lines[index];
  const next = lines[index + 1];
  if (/panicked at/.test(first) && next !== undefined) {
    return `${first} ${next}`;
  }
  return first;
}
