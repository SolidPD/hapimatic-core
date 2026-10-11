// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice input protocol (issue #4707, epic #4706).
 *
 * Shared by three runtimes:
 *  - web: records audio, decodes it to 16 kHz mono PCM16 WAV, POSTs it to
 *    `/api/voice/transcribe`, and reads `/api/voice/status`.
 *  - server (`builtin.voice-input` extension): owns the routes, the installer
 *    and the engine child process.
 *  - cli (`hapi voice-engine`): the child process; speaks newline-delimited JSON
 *    over stdio with the server.
 */
import { z } from "zod";

export const VOICE_MODEL_IDS = [
  "parakeet-tdt-0.6b-v2-int8",
  "parakeet-tdt-0.6b-v3-int8",
] as const;
export type VoiceModelId = (typeof VOICE_MODEL_IDS)[number];
export const DEFAULT_VOICE_MODEL: VoiceModelId = "parakeet-tdt-0.6b-v2-int8";

export const VOICE_ENGINE_STATES = [
  "not_installed",
  "installing",
  "installed",
  "loading",
  "loaded",
  "error",
] as const;
export type VoiceEngineState = (typeof VOICE_ENGINE_STATES)[number];

export const VOICE_ERROR_CODES = [
  "engine_not_installed",
  "engine_unavailable",
  "insufficient_memory",
  "engine_busy",
  "invalid_audio",
  "audio_too_large",
  "install_failed",
  "install_in_progress",
  "dev_mode_unsupported",
  "unsupported_platform",
  "invalid_request",
  "settings_unreadable",
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

/** Upper bounds shared by the browser (auto-stop) and the server (validation). */
export const VOICE_MAX_RECORDING_SECONDS = 300;
export const VOICE_SAMPLE_RATE = 16000;
/** 300 s of 16 kHz mono PCM16 is 9.6 MB; 12 MB leaves room for headers. */
export const VOICE_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const VOICE_IDLE_UNLOAD_MIN_SECONDS = 60;
export const VOICE_IDLE_UNLOAD_MAX_SECONDS = 3600;
export const VOICE_DEFAULT_IDLE_UNLOAD_SECONDS = 300;

export const VoiceModelInfoSchema = z
  .object({
    id: z.enum(VOICE_MODEL_IDS),
    label: z.string(),
    languages: z.string(),
    downloadBytes: z.number(),
    installed: z.boolean(),
  })
  .passthrough();
export type VoiceModelInfo = z.infer<typeof VoiceModelInfoSchema>;

export const VoiceInstallProgressSchema = z
  .object({
    phase: z.string(),
    bytesDone: z.number(),
    bytesTotal: z.number(),
  })
  .passthrough();
export type VoiceInstallProgress = z.infer<typeof VoiceInstallProgressSchema>;

export const VoiceStatusResponseSchema = z
  .object({
    available: z.literal(true),
    engine: z.literal("parakeet-local"),
    state: z.enum(VOICE_ENGINE_STATES),
    model: z.enum(VOICE_MODEL_IDS),
    models: z.array(VoiceModelInfoSchema),
    install: VoiceInstallProgressSchema.optional(),
    error: z.string().optional(),
    idleUnloadSeconds: z.number(),
    threads: z.number(),
    attribution: z.string(),
  })
  .passthrough();
export type VoiceStatusResponse = z.infer<typeof VoiceStatusResponseSchema>;

export const VoiceTranscribeResponseSchema = z
  .object({
    text: z.string(),
    audioSeconds: z.number(),
    decodeMs: z.number(),
  })
  .passthrough();
export type VoiceTranscribeResponse = z.infer<
  typeof VoiceTranscribeResponseSchema
>;

export const VoiceErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z.string(),
    code: z.enum(VOICE_ERROR_CODES),
  })
  .passthrough();
export type VoiceErrorResponse = z.infer<typeof VoiceErrorResponseSchema>;

export const VoiceSettingsUpdateSchema = z
  .object({
    model: z.enum(VOICE_MODEL_IDS).optional(),
    idleUnloadSeconds: z
      .number()
      .int()
      .min(VOICE_IDLE_UNLOAD_MIN_SECONDS)
      .max(VOICE_IDLE_UNLOAD_MAX_SECONDS)
      .optional(),
    threads: z.number().int().min(1).max(8).optional(),
  })
  .strict();
export type VoiceSettingsUpdate = z.infer<typeof VoiceSettingsUpdateSchema>;

export const VoiceInstallRequestSchema = z
  .object({ model: z.enum(VOICE_MODEL_IDS).optional() })
  .strict();

// ---------------------------------------------------------------------------
// Engine worker protocol (server <-> `hapi voice-engine`, NDJSON over stdio)
// ---------------------------------------------------------------------------

export const VoiceWorkerRequestSchema = z.object({
  id: z.number().int(),
  type: z.literal("transcribe"),
  /** Base64 of a 16 kHz mono PCM16 WAV file. */
  wavB64: z.string(),
});
export type VoiceWorkerRequest = z.infer<typeof VoiceWorkerRequestSchema>;

export const VoiceWorkerMessageSchema = z.union([
  z.object({ type: z.literal("ready") }),
  z.object({
    id: z.number().int(),
    ok: z.literal(true),
    text: z.string(),
    audioSeconds: z.number(),
    decodeMs: z.number(),
  }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.string(),
  }),
]);
export type VoiceWorkerMessage = z.infer<typeof VoiceWorkerMessageSchema>;

/** Parse one stdout line from the worker; returns null for non-protocol lines. */
export function parseVoiceWorkerLine(line: string): VoiceWorkerMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = VoiceWorkerMessageSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// WAV (16 kHz mono PCM16) parsing — shared by the server route (validation)
// and the worker (sample extraction). Walks RIFF chunks; never assumes a
// 44-byte header.
// ---------------------------------------------------------------------------

export type WavParseResult =
  | { ok: true; dataOffset: number; dataBytes: number; seconds: number }
  | { ok: false; error: string };

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

export function parseWav16kMono(bytes: Uint8Array): WavParseResult {
  if (bytes.byteLength < 12) return { ok: false, error: "too short for WAV" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") {
    return { ok: false, error: "not a RIFF/WAVE file" };
  }
  let offset = 12;
  let sawFmt = false;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) {
        return { ok: false, error: "truncated fmt chunk" };
      }
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const rate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1) return { ok: false, error: "WAV is not PCM" };
      if (channels !== 1) return { ok: false, error: "WAV must be mono" };
      if (rate !== VOICE_SAMPLE_RATE) {
        return { ok: false, error: `WAV must be ${VOICE_SAMPLE_RATE} Hz` };
      }
      if (bits !== 16) return { ok: false, error: "WAV must be 16-bit" };
      sawFmt = true;
    } else if (id === "data") {
      if (!sawFmt) return { ok: false, error: "data chunk before fmt chunk" };
      const dataBytes = Math.min(size, bytes.byteLength - body);
      const seconds = dataBytes / 2 / VOICE_SAMPLE_RATE;
      if (seconds > VOICE_MAX_RECORDING_SECONDS + 1) {
        return { ok: false, error: "recording longer than 5 minutes" };
      }
      return { ok: true, dataOffset: body, dataBytes, seconds };
    }
    offset = body + size + (size % 2);
  }
  return { ok: false, error: "no data chunk" };
}

/**
 * Encode mono float samples (-1..1) at `sampleRate` as a PCM16 WAV file.
 * Samples outside [-1, 1] are clamped.
 */
export function encodePcm16Wav(
  samples: Float32Array,
  sampleRate: number = VOICE_SAMPLE_RATE
): Uint8Array<ArrayBuffer> {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Decode the PCM16 data chunk of a parsed WAV into float samples (-1..1). */
export function pcm16ToFloat32(
  bytes: Uint8Array,
  dataOffset: number,
  dataBytes: number
): Float32Array {
  const count = Math.floor(dataBytes / 2);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + dataOffset,
    count * 2
  );
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
