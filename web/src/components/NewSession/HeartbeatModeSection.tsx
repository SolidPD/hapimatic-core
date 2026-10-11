// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useState } from "react";
import type { ApiClient } from "@/api/client";
import { FormField } from "./FormField";
import { BookmarkToggle } from "./bookmarkContext";
import { PromptTextarea } from "./PromptTextarea";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { DayOfWeekSelector } from "./DayOfWeekSelector";
import { BareButton } from "@/components/ui/BareButton";

function nowTimeLocal(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function HeartbeatModeSection(props: {
  heartbeatMode: boolean;
  standingOrdersMode: "inline" | "file";
  standingOrdersText: string;
  standingOrdersFile: string;
  ackToken: string;
  rotationMode: "time" | "count";
  rotationDays: boolean[];
  rotationTime: string;
  rotationCount: string;
  onHeartbeatModeChange: (checked: boolean) => void;
  onStandingOrdersModeChange: (mode: "inline" | "file") => void;
  onStandingOrdersTextChange: (text: string) => void;
  onStandingOrdersFileChange: (path: string) => void;
  onAckTokenChange: (token: string) => void;
  onRotationModeChange: (mode: "time" | "count") => void;
  onRotationDaysChange: (days: boolean[]) => void;
  onRotationTimeChange: (time: string) => void;
  onRotationCountChange: (count: string) => void;
  isDisabled?: boolean;
  api?: ApiClient;
  machineId?: string | null;
  nodeId?: string | null;
}) {
  const {
    heartbeatMode,
    standingOrdersMode,
    standingOrdersText,
    standingOrdersFile,
    ackToken,
    rotationMode,
    rotationDays,
    rotationTime,
    rotationCount,
    onHeartbeatModeChange,
    onStandingOrdersModeChange,
    onStandingOrdersTextChange,
    onStandingOrdersFileChange,
    onAckTokenChange,
    onRotationModeChange,
    onRotationDaysChange,
    onRotationTimeChange,
    onRotationCountChange,
    isDisabled = false,
    api,
    machineId,
    nodeId,
  } = props;

  const [isBrowserOpen, setIsBrowserOpen] = useState(false);

  const canBrowse = !isDisabled && !!api && (!!machineId || !!nodeId);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <label className="relative inline-flex h-5 w-9 items-center">
          <input
            type="checkbox"
            checked={heartbeatMode}
            onChange={e => onHeartbeatModeChange(e.target.checked)}
            disabled={isDisabled}
            className="peer sr-only"
          />
          <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)] peer-disabled:opacity-50" />
          <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
        </label>
        <span className="text-sm font-medium text-[var(--app-fg)]">
          Heartbeat Mode
        </span>
        <BookmarkToggle id="schedule.heartbeat" />
      </div>
      <p className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)] -mt-1">
        Turns this scheduled session into an autonomous monitoring agent. The
        session reads standing orders on each tick and reports back.
      </p>

      {/* Conditional fields — visible when heartbeat mode is checked */}
      <div
        className={`overflow-hidden transition-all duration-200 ease-in-out ${
          heartbeatMode ? "max-h-[1200px] opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="flex flex-col gap-2.5 pt-1">
          {/* Standing Orders mode toggle */}
          <FormField
            label="Standing Orders"
            tooltip="Instructions the LLM reads on every heartbeat tick. If nothing needs attention, the agent responds with the acknowledgment token."
            bookmarkId="schedule.standingOrders"
          >
            <div className="flex flex-col gap-2">
              <div className="flex gap-3">
                <label className="flex items-center gap-1.5 text-xs text-[var(--app-fg)] cursor-pointer">
                  <input
                    type="radio"
                    name="standingOrdersMode"
                    value="inline"
                    checked={standingOrdersMode === "inline"}
                    onChange={() => onStandingOrdersModeChange("inline")}
                    disabled={isDisabled}
                    className="accent-[var(--app-link)]"
                  />
                  Inline text
                </label>
                <label className="flex items-center gap-1.5 text-xs text-[var(--app-fg)] cursor-pointer">
                  <input
                    type="radio"
                    name="standingOrdersMode"
                    value="file"
                    checked={standingOrdersMode === "file"}
                    onChange={() => onStandingOrdersModeChange("file")}
                    disabled={isDisabled}
                    className="accent-[var(--app-link)]"
                  />
                  File path
                </label>
              </div>

              {standingOrdersMode === "inline" && (
                <PromptTextarea
                  value={standingOrdersText}
                  onChange={onStandingOrdersTextChange}
                  isDisabled={isDisabled}
                  placeholder="Enter standing orders for the heartbeat agent..."
                />
              )}

              {standingOrdersMode === "file" && (
                <div className="flex gap-2">
                  <input
                    autoCapitalize="none"
                    type="text"
                    value={standingOrdersFile}
                    onChange={e => onStandingOrdersFileChange(e.target.value)}
                    disabled={isDisabled}
                    placeholder="/path/to/standing-orders.md"
                    className="flex-1 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
                  />
                  <BareButton
                    type="button"
                    onClick={() => canBrowse && setIsBrowserOpen(true)}
                    disabled={!canBrowse}
                    className="px-3 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Browse directories"
                    aria-label="Browse directories"
                  >
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
                    </svg>
                  </BareButton>
                </div>
              )}
            </div>
          </FormField>

          {/* Acknowledgment Token */}
          <FormField
            label="Acknowledgment Token"
            tooltip="The text string the LLM responds with when nothing needs attention. Responses containing this token are automatically suppressed from notifications."
            bookmarkId="schedule.ackToken"
          >
            <input
              autoCapitalize="none"
              type="text"
              value={ackToken}
              onChange={e => onAckTokenChange(e.target.value)}
              disabled={isDisabled}
              placeholder="HEARTBEAT_OK"
              className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50 font-mono"
            />
          </FormField>

          {/* Session Reuse Rotation */}
          <FormField
            label="Session Reuse Rotation"
            tooltip="Controls how often a reused session is rotated (deleted and replaced). Periodic rotation prevents sessions from growing indefinitely."
            bookmarkId="schedule.rotation"
          >
            <div className="flex flex-col gap-2">
              <div className="flex gap-3">
                <label className="flex items-center gap-1.5 text-xs text-[var(--app-fg)] cursor-pointer">
                  <input
                    type="radio"
                    name="rotationMode"
                    value="time"
                    checked={rotationMode === "time"}
                    onChange={() => onRotationModeChange("time")}
                    disabled={isDisabled}
                    className="accent-[var(--app-link)]"
                  />
                  Time-based
                </label>
                <label className="flex items-center gap-1.5 text-xs text-[var(--app-fg)] cursor-pointer">
                  <input
                    type="radio"
                    name="rotationMode"
                    value="count"
                    checked={rotationMode === "count"}
                    onChange={() => onRotationModeChange("count")}
                    disabled={isDisabled}
                    className="accent-[var(--app-link)]"
                  />
                  Count-based
                </label>
              </div>

              {rotationMode === "time" && (
                <div className="flex flex-col gap-2">
                  <DayOfWeekSelector
                    activeDays={rotationDays}
                    onChange={onRotationDaysChange}
                    isDisabled={isDisabled}
                  />
                  <div className="flex gap-1.5">
                    <input
                      type="time"
                      value={rotationTime}
                      onChange={e => onRotationTimeChange(e.target.value)}
                      disabled={isDisabled}
                      className="flex-1 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
                    />
                    <BareButton
                      type="button"
                      onClick={() => onRotationTimeChange(nowTimeLocal())}
                      disabled={isDisabled}
                      className="shrink-0 rounded-md border border-[var(--app-border)] px-2 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-30"
                      title="Set to current time"
                    >
                      Now
                    </BareButton>
                  </div>
                </div>
              )}

              {rotationMode === "count" && (
                <div>
                  <input
                    autoCapitalize="none"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={rotationCount}
                    onChange={e => onRotationCountChange(e.target.value)}
                    onFocus={e => e.target.select()}
                    disabled={isDisabled}
                    placeholder="5"
                    className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
                  />
                  <span className="text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
                    After X uses, rotate the session
                  </span>
                </div>
              )}
            </div>
          </FormField>
        </div>
      </div>

      {/* Directory browser modal */}
      {isBrowserOpen && api && (machineId || nodeId) && (
        <DirectoryBrowser
          api={api}
          machineId={machineId ?? null}
          nodeId={nodeId}
          initialPath={standingOrdersFile || "/"}
          onSelect={path => onStandingOrdersFileChange(path)}
          onClose={() => setIsBrowserOpen(false)}
        />
      )}
    </div>
  );
}
