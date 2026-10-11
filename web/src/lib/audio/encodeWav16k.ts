// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Convert a MediaRecorder clip (audio/mp4 on iOS Safari, audio/webm elsewhere)
 * to a 16 kHz mono PCM16 WAV for the on-node speech engine (issue #4707).
 *
 * Decoding happens in the browser so nodes need no ffmpeg: decodeAudioData
 * handles each browser's own recording format, and an OfflineAudioContext
 * resamples to 16 kHz.
 */
import { VOICE_SAMPLE_RATE, encodePcm16Wav } from "@hapi/protocol/voice";

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Blob bytes; falls back to Response for environments without Blob.arrayBuffer. */
export async function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return typeof blob.arrayBuffer === "function"
    ? await blob.arrayBuffer()
    : await new Response(blob).arrayBuffer();
}

/** Downmix to mono by averaging channels. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const length = channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i]! += channel[i]! / channels.length;
  }
  return out;
}

export async function blobToWav16k(
  blob: Blob
): Promise<{ wav: Blob; bytes: Uint8Array<ArrayBuffer>; seconds: number }> {
  const Ctor = audioContextCtor();
  if (!Ctor || typeof OfflineAudioContext === "undefined") {
    throw new Error("This browser cannot process audio recordings.");
  }
  const ctx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blobBytes(blob));
  } finally {
    void ctx.close().catch(() => {});
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, VOICE_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const channels: Float32Array[] = [];
  for (let i = 0; i < rendered.numberOfChannels; i++) {
    channels.push(rendered.getChannelData(i));
  }
  const bytes = encodePcm16Wav(downmixToMono(channels), VOICE_SAMPLE_RATE);
  return {
    wav: new Blob([bytes], { type: "audio/wav" }),
    bytes,
    seconds: decoded.duration,
  };
}
