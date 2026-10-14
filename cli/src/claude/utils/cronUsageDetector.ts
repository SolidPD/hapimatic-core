// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects in-session cron / loop-wakeup usage (CronCreate, ScheduleWakeup tool
 * calls) in the JSONL session message stream and surfaces a non-silent
 * reliability warning via logger.reportError() — reusing the #1078/#1107
 * tool-error toast path.
 *
 * Why this exists (issue #1460): Claude Code's in-session cron (CronCreate)
 * registers a job and returns a healthy-looking success message, but the cron
 * only fires while the session is idle AND is unreliable in long-lived sessions
 * (a timer-longevity bug in Anthropic's compiled binary that Hapimatic cannot
 * patch). A PM session once sat ~2h assuming a registered-but-never-fired cron
 * was monitoring background work. Hapimatic cannot modify the compiled tool's
 * success message, so a detection-layer warning toast is the only "no
 * silent-success" lever. See claudedocs/cron-in-hapimatic.md.
 *
 * ScheduleWakeup (issue #1256) is the /loop dynamic-pacing sibling. It rides the
 * SAME session-cron machinery (`kind: "loop"`) and shares the identical failure
 * mode — empirically verified to register cleanly and fire in a FRESH session,
 * but silently stop in long-lived / actively-busy sessions (the rp1-home#590
 * trigger case). The bug is launcher-independent: the SDK (`--print`), tmux, and
 * pty launchers all run the same `claude` binary cron scheduler, and this
 * detector is wired into all three. Because the tool genuinely works in short
 * sessions, the correct treatment is a non-blocking WARNING (not a hard block),
 * mirroring CronCreate.
 *
 * Sibling of ToolErrorDetector / UserPromptBlockDetector: tool errors arrive as
 * tool_result.is_error on USER messages and hook blocks as SYSTEM messages;
 * this detector watches ASSISTANT messages for a tool_use block whose name is a
 * watched in-session-cron tool.
 *
 * Single-session contract: each instance is intended to live for the lifetime
 * of one session scanner. Launchers with crash-restart loops (claudeRemote)
 * MUST call reset() between attempts to prevent a previously-warned tool_use_id
 * from suppressing a legitimate new warning after the SDK recycles ids.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

/**
 * Tool names that schedule in-session work via Claude Code's cron machinery and
 * therefore share the idle-gating + long-session timer-longevity caveat — both
 * inside Anthropic's compiled binary, which Hapimatic cannot patch.
 *
 * - CronCreate (#1460): recurring in-session cron.
 * - ScheduleWakeup (#1256): the /loop dynamic-pacing one-shot wakeup. Same
 *   session-cron machinery (`kind: "loop"`), same failure mode.
 */
const WATCHED_CRON_TOOLS = new Set<string>(["CronCreate", "ScheduleWakeup"]);

/**
 * Per-tool caveat shown as the toast body. Kept <= 120 chars because the web
 * ToolErrorToastListener truncates errorContent at 120 (web/src/App.tsx). A
 * watched tool with no specific entry falls back to {@link DEFAULT_CAVEAT}.
 */
const CAVEAT_BY_TOOL: Record<string, string> = {
  CronCreate:
    "Only fires while idle & can silently stop in long sessions — unreliable for monitoring. Use the native scheduler.",
  ScheduleWakeup:
    "Only fires while idle & can silently stop in long sessions — unreliable for self-pacing. Use the native scheduler.",
};

/** Fallback caveat for any watched tool without a {@link CAVEAT_BY_TOOL} entry. */
const DEFAULT_CAVEAT =
  "Only fires while idle & can silently stop in long sessions — unreliable for monitoring. Use the native scheduler.";

export class CronUsageDetector {
  /** Tracks already-warned tool_use_ids to avoid duplicate toasts. */
  private readonly warnedIds = new Set<string>();

  constructor() {}

  /**
   * Clear internal state. Call between session attempts in launchers with
   * crash-restart loops so a warned id from a previous run doesn't suppress a
   * legitimate new warning after the SDK recycles ids.
   */
  reset(): void {
    this.warnedIds.clear();
  }

  /**
   * Process a parsed JSONL message. For assistant messages, scan tool_use
   * blocks for a watched in-session-cron tool and emit a one-time warning per
   * tool_use_id. All other message types no-op.
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;
    if (message.type !== "assistant") return;

    const msg = message as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner) return;

    const content = inner.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        WATCHED_CRON_TOOLS.has(block.name)
      ) {
        this.warnCronUsage(block.id, block.name, sessionId);
      }
    }
  }

  private warnCronUsage(
    toolUseId: string,
    cronTool: string,
    sessionId: string
  ): void {
    // Dedup: warn once per tool_use_id (the message stream can re-feed the same
    // assistant message, e.g. across scanner re-reads).
    if (this.warnedIds.has(toolUseId)) return;
    this.warnedIds.add(toolUseId);

    // Tool-aware label + caveat so a ScheduleWakeup warning reads "ScheduleWakeup"
    // (not "CronCreate") and carries a use-case-appropriate caveat (issue #1256).
    const toastLabel = `In-session cron (${cronTool})`;
    const caveat = CAVEAT_BY_TOOL[cronTool] ?? DEFAULT_CAVEAT;

    // toolName + errorContent are the fields the server's tool-error broadcast
    // branch (server/src/web/routes/cli.ts) extracts from `context` to build the
    // hapi:toolError toast. Supplying a concrete toolName avoids the "unknown"
    // fallback and renders an accurate `${toolName}: ${errorContent}` warning.
    const context: Record<string, unknown> = {
      toolName: toastLabel,
      toolUseId,
      errorContent: caveat,
      cronTool,
    };

    logger.reportError({
      message: `In-session cron used (${cronTool}) — ${caveat}`,
      category: "cron-usage-warning",
      severity: "warn",
      sessionId,
      context: JSON.stringify(context),
    });
  }
}
