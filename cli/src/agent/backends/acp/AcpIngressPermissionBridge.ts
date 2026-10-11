// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ACP ingress permission bridge (issue #1906, Task 4) — the load-bearing
 * governance guarantee (R4).
 *
 * Supplies the `canCallTool` callback that `claudeRemote()` invokes for every
 * tool the SDK launcher wants to run. Instead of the PWA's in-app approval, it
 * surfaces an ACP `session/request_permission` request to the connected editor
 * and awaits the outcome with a BOUNDED timeout. Any non-answer — timeout, the
 * turn's abort signal, or a transport error (editor disconnect) — resolves to
 * `{ behavior: "deny" }`. Default-deny-on-timeout is fail-closed by construction.
 *
 * Mirrors the option/outcome mapping in `cli/src/agent/permissionAdapter.ts`
 * (inverse direction). Those internals are module-private there — this is a
 * pattern MIRROR, not an import.
 */
import { randomUUID } from "node:crypto";
import type { PermissionResult } from "@/claude/sdk/types";
import type { EnhancedMode } from "@/claude/loop";
import { asString, isObject } from "@/agent/utils";
import { logger } from "@/ui/logger";
import type { AcpTransport } from "./AcpStdioTransport";

/**
 * Bounded window an editor has to answer a `session/request_permission` before
 * the ingress denies by default. Matches Hapimatic's other 2-min tool timeouts.
 */
export const ACP_PERMISSION_TIMEOUT_MS = 120_000;

/** Outcome of the race between the editor reply, the timeout, and the signal. */
type PermissionRace =
  | { kind: "answered"; outcome: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "transport_error"; error: unknown };

export class AcpIngressPermissionBridge {
  constructor(
    private readonly transport: AcpTransport,
    private readonly sessionId: string,
    private readonly timeoutMs: number = ACP_PERMISSION_TIMEOUT_MS
  ) {}

  /**
   * The `canCallTool` callback for `claudeRemote()`. Bound as an arrow property
   * so it can be passed directly (`canCallTool: bridge.canCallTool`) without
   * losing `this`.
   */
  readonly canCallTool = async (
    toolName: string,
    input: unknown,
    _mode: EnhancedMode,
    options: { signal: AbortSignal }
  ): Promise<PermissionResult> => {
    const toolCallId = `acp-perm-${randomUUID()}`;
    const acpOptions = [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ];

    const requestPromise = this.transport.sendRequest(
      "session/request_permission",
      {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId,
          title: toolName,
          kind: "other",
          rawInput: input,
        },
        options: acpOptions,
      }
    );

    const race = await this.raceOutcome(requestPromise, options.signal);

    switch (race.kind) {
      case "answered":
        return this.interpretOutcome(race.outcome, input, toolName);
      case "timeout":
        logger.debug(
          `[ACP] permission for "${toolName}" timed out (${this.timeoutMs}ms) — default deny`
        );
        return {
          behavior: "deny",
          message: `ACP permission request for "${toolName}" timed out after ${this.timeoutMs}ms — denied by default.`,
        };
      case "aborted":
        return {
          behavior: "deny",
          message: `ACP permission request for "${toolName}" was aborted — denied.`,
        };
      case "transport_error":
        logger.debug(
          `[ACP] permission transport error for "${toolName}" — default deny`,
          race.error
        );
        return {
          behavior: "deny",
          message: `ACP permission request for "${toolName}" failed (editor disconnected?) — denied.`,
        };
    }
  };

  /**
   * Resolve as soon as ANY of: the editor answers, the timeout elapses, the
   * abort signal fires, or the transport rejects. Never rejects — the caller
   * maps every non-answer to a deny.
   */
  private raceOutcome(
    requestPromise: Promise<unknown>,
    signal: AbortSignal
  ): Promise<PermissionRace> {
    return new Promise<PermissionRace>(resolve => {
      let settled = false;
      const settle = (result: PermissionRace): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };

      const timer = setTimeout(
        () => settle({ kind: "timeout" }),
        this.timeoutMs
      );
      const onAbort = (): void => settle({ kind: "aborted" });

      if (signal.aborted) {
        settle({ kind: "aborted" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });

      requestPromise.then(
        outcome => settle({ kind: "answered", outcome }),
        error => settle({ kind: "transport_error", error })
      );
    });
  }

  /**
   * Map the editor's `{ outcome: { outcome: "selected", optionId } | { outcome:
   * "cancelled" } }` reply to a `PermissionResult`. Only an explicit selection of
   * an `allow*` option grants; everything else (reject, cancelled, malformed)
   * denies. This is the inverse of `AcpSdkBackend.respondToPermission`.
   */
  private interpretOutcome(
    outcome: unknown,
    input: unknown,
    toolName: string
  ): PermissionResult {
    const inner = isObject(outcome) ? outcome.outcome : undefined;
    if (isObject(inner) && inner.outcome === "selected") {
      const optionId = asString(inner.optionId);
      if (optionId && optionId.startsWith("allow")) {
        return {
          behavior: "allow",
          updatedInput: isObject(input) ? input : {},
        };
      }
    }
    return {
      behavior: "deny",
      message: `ACP permission request for "${toolName}" was denied by the editor.`,
    };
  }
}
