// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat Integration — Pure Helper Functions
 *
 * Extracted from HeartbeatService for shared use between the legacy
 * heartbeat system (during transition) and the new TaskExecutor
 * heartbeat execution path.
 *
 * All functions are pure or async-pure (no shared mutable state).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { SystemEvent } from "../../../heartbeat/types";
import type { CreateScheduledTask } from "./types";
import {
  loadHeartbeatConfig,
  hasHeartbeatConfig,
} from "../../../config/heartbeatConfig";
import {
  getSettingsFile,
  readSettings,
  writeSettings,
} from "../../../config/settings";

// ---------- Prompt Construction ----------

/**
 * Build heartbeat prompt from system events + standing orders.
 *
 * Extracted from HeartbeatService.buildPrompt() — the prompt includes
 * all queued system events (timestamped) followed by a reference to the
 * standing orders file path. The agent is expected to read the file itself.
 */
export function buildHeartbeatPrompt(
  systemEvents: SystemEvent[],
  instructionsFilePath: string
): string {
  const parts: string[] = [];

  for (const event of systemEvents) {
    const ts = new Date(event.timestamp).toISOString();
    parts.push(`System: [${ts}] ${event.description} (from ${event.source})`);
  }

  parts.push("");
  parts.push(`Read your standing orders file at ${instructionsFilePath}.`);
  parts.push(
    "Follow the instructions strictly. Do not repeat old tasks from prior heartbeats."
  );
  parts.push("If nothing needs attention, reply HEARTBEAT_OK.");

  return parts.join("\n");
}

// ---------- Response Evaluation ----------

/**
 * Evaluate whether a heartbeat response should suppress push notifications.
 *
 * Suppresses when:
 * - Response is null/empty (timeout or no response)
 * - Response contains "HEARTBEAT_OK" (explicit acknowledgement)
 * - Response length is at or below the ackMaxChars threshold (short ack)
 *
 * Extracted from HeartbeatService.shouldSuppress()
 */
export function shouldSuppressResponse(
  response: string | null,
  ackMaxChars: number
): boolean {
  if (!response) return true;
  if (response.includes("HEARTBEAT_OK")) return true;
  if (response.length <= ackMaxChars) return true;
  return false;
}

// ---------- Message Parsing ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract text from Claude Code's nested message format.
 *
 * Claude Code messages use a deeply nested structure:
 *   DecryptedMessage.content = {
 *     role: "assistant",
 *     content: {
 *       type: "output",
 *       data: {
 *         type: "assistant",
 *         message: { content: string | Array<{ type: "text", text: string }> }
 *       }
 *     }
 *   }
 *
 * Mirrors the extraction logic in web/src/chat/normalizeAgent.ts.
 * Extracted from heartbeatService.ts extractResponseText().
 */
export function extractResponseText(
  messages: Array<{ content: unknown }>
): string {
  const parts: string[] = [];

  for (const m of messages) {
    const wrapper = m.content;
    if (!isObj(wrapper)) continue;

    const inner = wrapper.content;
    if (!isObj(inner) || inner.type !== "output") continue;

    const data = isObj(inner.data) ? inner.data : null;
    if (!data || data.type !== "assistant") continue;

    const message = isObj(data.message) ? data.message : null;
    if (!message) continue;

    const modelContent = message.content;
    if (typeof modelContent === "string") {
      parts.push(modelContent);
    } else if (Array.isArray(modelContent)) {
      for (const block of modelContent) {
        if (
          isObj(block) &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          parts.push(block.text);
        }
      }
    }
  }

  return parts.filter(Boolean).join("\n");
}

// ---------- Active Hours Check ----------

/**
 * Check if the current time is within the operating schedule's active hours.
 *
 * The operating schedule stores clockIn/clockOut as hour integers (0-23).
 * Supports overnight ranges (e.g., 22-8 spans midnight).
 *
 * Extracted from HeartbeatService.isWithinActiveHours()
 */
export function isWithinActiveHours(
  operatingSchedule: {
    clockIn: number;
    clockOut: number;
    timezone: string;
  } | null
): boolean {
  if (!operatingSchedule) return true; // No schedule = always active

  const { clockIn, clockOut, timezone } = operatingSchedule;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  });
  const currentHour = parseInt(formatter.format(now), 10);

  if (clockIn < clockOut) {
    // Normal range: e.g., 8-22
    return currentHour >= clockIn && currentHour < clockOut;
  } else {
    // Overnight range: e.g., 22-8
    return currentHour >= clockIn || currentHour < clockOut;
  }
}

// ---------- Migration ----------

/**
 * Migrate heartbeat config from settings.json to a CreateScheduledTask input.
 *
 * Reads the legacy `heartbeat` key from settings.json. If present:
 * 1. Maps all fields to the scheduler's CreateScheduledTask format
 * 2. Reads standing orders file content (stored in DB, not as a path)
 * 3. Renames the `heartbeat` key to `heartbeat_migrated` in settings.json
 *
 * Returns null if:
 * - No heartbeat config found
 * - Config already migrated (key is `heartbeat_migrated`)
 * - Config exists but is disabled
 */
export async function migrateHeartbeatConfig(
  dataDir: string,
  _namespace: string
): Promise<CreateScheduledTask | null> {
  // Check if legacy heartbeat config exists
  const hasConfig = await hasHeartbeatConfig(dataDir);
  if (!hasConfig) return null;

  const config = await loadHeartbeatConfig(dataDir);

  // Don't migrate disabled configs — they haven't been set up
  if (!config.enabled) return null;

  // Read standing orders file content for DB storage
  let standingOrders: string | null = null;
  if (config.instructionsFile && existsSync(config.instructionsFile)) {
    standingOrders = await readFile(config.instructionsFile, "utf-8");
  }

  // Build operating schedule JSON from active hours
  // Convert numeric hours (0-23) to "HH:MM" strings for temporal filter compatibility
  const operatingSchedule = JSON.stringify({
    clockIn: `${String(config.activeHours.start).padStart(2, "0")}:00`,
    clockOut: `${String(config.activeHours.end).padStart(2, "0")}:00`,
    timezone: config.activeHours.timezone,
    activeDays: [0, 1, 2, 3, 4, 5, 6], // All days (heartbeat ran every day)
    everyNWeeks: 1,
  });

  // Build rotation config JSON
  const rotationConfig = JSON.stringify({
    mode: "count",
    count: config.rotateAfterBeats,
  });

  const task: CreateScheduledTask = {
    name: config.sessionName ?? "HEARTBEAT",
    emoji: config.sessionEmoji ?? "💓",
    prompt: "(heartbeat — prompt built dynamically)",
    projectDirectory: config.sessionDirectory,
    scheduleType: "every",
    intervalMs: config.every,
    timezone: config.activeHours.timezone,
    notifyOn: "none", // Heartbeat handles its own notifications
    overlapPolicy: "skip",
    heartbeatMode: true,
    standingOrders: standingOrders ?? undefined,
    ackMaxChars: config.ackMaxChars,
    operatingSchedule,
    rotationConfig,
    runOnceAtCreation: false,
  };

  // Rename heartbeat → heartbeat_migrated in settings.json
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  if (settings) {
    const raw = settings as Record<string, unknown>;
    raw.heartbeat_migrated = raw.heartbeat;
    delete raw.heartbeat;
    await writeSettings(settingsFile, raw);
  }

  return task;
}
