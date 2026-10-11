// SPDX-License-Identifier: AGPL-3.0-only
import type { ToolViewProps } from "@/ext/host";

type WakeupInput = {
  delaySeconds?: number;
  reason?: string;
  prompt?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function extractInput(input: unknown): WakeupInput {
  if (!isObject(input)) return {};
  return {
    delaySeconds:
      typeof input.delaySeconds === "number" ? input.delaySeconds : undefined,
    reason: typeof input.reason === "string" ? input.reason : undefined,
    prompt: typeof input.prompt === "string" ? input.prompt : undefined,
  };
}

function extractResultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (isObject(result) && typeof result.content === "string")
    return result.content;
  return undefined;
}

function formatLocal(d: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toString();
  }
}

function formatUtc(d: Date): string {
  try {
    const iso = d.toISOString();
    return `${iso.substring(0, 10)} ${iso.substring(11, 19)} UTC`;
  } catch {
    return "(invalid date)";
  }
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

export function ScheduleWakeupView(props: ToolViewProps) {
  const { delaySeconds, reason, prompt } = extractInput(props.block.tool.input);
  const resultText = extractResultText(props.block.tool.result);
  const anchorMs =
    props.block.tool.startedAt ?? props.block.tool.createdAt ?? Date.now();
  const fireDate =
    typeof delaySeconds === "number" &&
    Number.isFinite(delaySeconds) &&
    delaySeconds >= 0
      ? new Date(anchorMs + delaySeconds * 1000)
      : null;

  return (
    <div className="flex flex-col gap-2 text-sm">
      {fireDate ? (
        <div className="flex flex-col gap-0.5">
          <div className="text-[var(--app-fg)]">
            <span className="text-[var(--app-hint)]">Fires at:</span>{" "}
            <span className="font-mono">{formatLocal(fireDate)}</span>
          </div>
          <div className="text-[var(--app-hint)] font-mono pl-[3.7rem]">
            = {formatUtc(fireDate)}
          </div>
        </div>
      ) : (
        <div className="text-[var(--app-hint)]">
          ScheduleWakeup invoked (delay unavailable)
        </div>
      )}

      {typeof delaySeconds === "number" && (
        <div className="text-[var(--app-hint)]">
          <span>Delay:</span>{" "}
          <span className="font-mono text-[var(--app-fg)]">
            {formatDelay(delaySeconds)}
          </span>
        </div>
      )}

      {reason && (
        <div className="text-[var(--app-fg)]">
          <span className="text-[var(--app-hint)]">Reason:</span> {reason}
        </div>
      )}

      {prompt && (
        <details className="text-[var(--app-hint)]">
          <summary className="cursor-pointer hover:text-[var(--app-fg)]">
            Prompt ({prompt.length} chars)
          </summary>
          <pre className="mt-1 whitespace-pre-wrap text-xs text-[var(--app-fg)] bg-black/20 rounded px-2 py-1">
            {prompt}
          </pre>
        </details>
      )}

      {resultText && (
        <div className="text-[var(--app-hint)]">
          <span>Tool reply:</span>{" "}
          <span className="font-mono text-[var(--app-fg)]">{resultText}</span>
        </div>
      )}

      <div className="text-xs italic text-[var(--app-hint)] border-t border-white/5 pt-1.5 mt-0.5">
        Note: wakeups defer until the session is idle and may fire
        seconds-to-minutes after the scheduled time if the conversation is
        active. The fire time above is when the wakeup is queued — it may not
        match exactly.
      </div>
    </div>
  );
}
