// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice input settings, stored under the `voiceInput` key of the instance's
 * settings.json (issue #4707). The extension loads it once at register and
 * keeps it in memory; `PUT /voice/settings` updates both the file and memory.
 */
import {
  DEFAULT_VOICE_MODEL,
  VOICE_DEFAULT_IDLE_UNLOAD_SECONDS,
  VOICE_IDLE_UNLOAD_MAX_SECONDS,
  VOICE_IDLE_UNLOAD_MIN_SECONDS,
  VOICE_MODEL_IDS,
  type VoiceModelId,
  type VoiceSettingsUpdate,
} from "@hapi/protocol/voice";
import {
  getSettingsFile,
  readSettings,
  readSettingsOrThrow,
  writeSettings,
} from "../../config/settings";

export interface VoiceInputConfig {
  model: VoiceModelId;
  idleUnloadSeconds: number;
  threads: number;
}

export const DEFAULT_VOICE_THREADS = 2;

export function normalizeVoiceInputConfig(raw: unknown): VoiceInputConfig {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const model = (VOICE_MODEL_IDS as readonly unknown[]).includes(value.model)
    ? (value.model as VoiceModelId)
    : DEFAULT_VOICE_MODEL;
  const idle =
    typeof value.idleUnloadSeconds === "number" &&
    Number.isFinite(value.idleUnloadSeconds)
      ? Math.min(
          VOICE_IDLE_UNLOAD_MAX_SECONDS,
          Math.max(
            VOICE_IDLE_UNLOAD_MIN_SECONDS,
            Math.round(value.idleUnloadSeconds)
          )
        )
      : VOICE_DEFAULT_IDLE_UNLOAD_SECONDS;
  const threads =
    typeof value.threads === "number" &&
    Number.isInteger(value.threads) &&
    value.threads >= 1 &&
    value.threads <= 8
      ? value.threads
      : DEFAULT_VOICE_THREADS;
  return { model, idleUnloadSeconds: idle, threads };
}

export async function loadVoiceInputConfig(
  dataDir: string
): Promise<VoiceInputConfig> {
  const settings = await readSettings(getSettingsFile(dataDir));
  return normalizeVoiceInputConfig(
    (settings as Record<string, unknown> | null)?.voiceInput
  );
}

export async function saveVoiceInputConfig(
  dataDir: string,
  update: VoiceSettingsUpdate
): Promise<VoiceInputConfig> {
  const file = getSettingsFile(dataDir);
  // Never write back a file that failed to parse: it holds the instance's
  // token and keys, and readSettings returns null precisely to prevent that.
  const settings = (await readSettingsOrThrow(file)) as Record<string, unknown>;
  const existing =
    settings.voiceInput && typeof settings.voiceInput === "object"
      ? (settings.voiceInput as Record<string, unknown>)
      : {};
  const merged = normalizeVoiceInputConfig({ ...existing, ...update });
  settings.voiceInput = merged;
  await writeSettings(file, settings);
  return merged;
}
