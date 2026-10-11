// SPDX-License-Identifier: MIT
/**
 * `hapi voice-engine` — the on-node speech-to-text worker (issue #4707).
 *
 * The server's `builtin.voice-input` extension starts this as a CHILD process
 * of the hapi binary (`<binary> voice-engine …`) and kills it after an idle
 * period. A separate process is deliberate: freeing the recognizer inside a
 * long-lived process only returned ~40% of its memory (measured: 1088 MB →
 * 670 MB), whereas exiting the child returns all of it.
 *
 * Nothing native is bundled into the hapi binary. The sherpa-onnx Node addon
 * is loaded at runtime from the directory the installer populated
 * (`--addon-dir`), which works from a `bun build --compile` executable.
 *
 * Protocol (newline-delimited JSON):
 *   stdout ← {"type":"ready"} once the model is loaded
 *   stdin  → {"id":N,"type":"transcribe","wavB64":"<16 kHz mono PCM16 WAV>"}
 *   stdout ← {"id":N,"ok":true,"text":"…","audioSeconds":…,"decodeMs":…}
 *          | {"id":N,"ok":false,"error":"…"}
 * Diagnostics go to stderr only. Exits 0 on stdin EOF.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  VoiceWorkerRequestSchema,
  VOICE_SAMPLE_RATE,
  parseWav16kMono,
  pcm16ToFloat32,
} from "@hapi/protocol/voice";
import type { CommandDefinition } from "./types";

/** The subset of the sherpa-onnx addon this worker calls. */
export interface SherpaAddon {
  createOfflineRecognizer(config: unknown): unknown;
  createOfflineStream(recognizer: unknown): unknown;
  acceptWaveformOffline(
    stream: unknown,
    wave: { sampleRate: number; samples: Float32Array }
  ): void;
  decodeOfflineStream(recognizer: unknown, stream: unknown): void;
  getOfflineStreamResultAsJson(stream: unknown): string;
  createVoiceActivityDetector(config: unknown, bufferSeconds: number): unknown;
  voiceActivityDetectorAcceptWaveform(
    vad: unknown,
    samples: Float32Array
  ): void;
  voiceActivityDetectorIsEmpty(vad: unknown): boolean;
  voiceActivityDetectorFront(
    vad: unknown,
    enableExternalBuffer: boolean
  ): { samples: Float32Array; start: number };
  voiceActivityDetectorPop(vad: unknown): void;
  voiceActivityDetectorFlush(vad: unknown): void;
}

export interface VoiceEngineOptions {
  modelDir: string;
  vadFile: string;
  threads: number;
}

const VAD_WINDOW = 512;
/** Longest segment handed to the recognizer; longer single passes lose punctuation. */
export const VAD_MAX_SEGMENT_SECONDS = 20;

export function loadSherpaAddon(addonDir: string): SherpaAddon {
  const req = createRequire(join(addonDir, "/"));
  return req(join(addonDir, "sherpa-onnx.node")) as SherpaAddon;
}

export function createVoiceEngine(
  addon: SherpaAddon,
  opts: VoiceEngineOptions
) {
  const recognizer = addon.createOfflineRecognizer({
    featConfig: { sampleRate: VOICE_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(opts.modelDir, "encoder.int8.onnx"),
        decoder: join(opts.modelDir, "decoder.int8.onnx"),
        joiner: join(opts.modelDir, "joiner.int8.onnx"),
      },
      tokens: join(opts.modelDir, "tokens.txt"),
      numThreads: opts.threads,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
    decodingMethod: "greedy_search",
  });

  const vadConfig = {
    sileroVad: {
      model: opts.vadFile,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      maxSpeechDuration: VAD_MAX_SEGMENT_SECONDS,
      windowSize: VAD_WINDOW,
    },
    sampleRate: VOICE_SAMPLE_RATE,
    debug: 0,
    numThreads: 1,
  };

  function decodeSegment(samples: Float32Array): string {
    const stream = addon.createOfflineStream(recognizer);
    addon.acceptWaveformOffline(stream, {
      sampleRate: VOICE_SAMPLE_RATE,
      samples,
    });
    addon.decodeOfflineStream(recognizer, stream);
    const result = JSON.parse(addon.getOfflineStreamResultAsJson(stream)) as {
      text?: string;
    };
    return (result.text ?? "").trim();
  }

  /** Split on pauses (Silero VAD), transcribe each segment, join with spaces. */
  function transcribeSamples(samples: Float32Array): string {
    const vad = addon.createVoiceActivityDetector(vadConfig, 60);
    const parts: string[] = [];
    const drain = () => {
      while (!addon.voiceActivityDetectorIsEmpty(vad)) {
        const segment = addon.voiceActivityDetectorFront(vad, false);
        addon.voiceActivityDetectorPop(vad);
        const text = decodeSegment(segment.samples);
        if (text) parts.push(text);
      }
    };
    for (let i = 0; i < samples.length; i += VAD_WINDOW) {
      addon.voiceActivityDetectorAcceptWaveform(
        vad,
        samples.subarray(i, i + VAD_WINDOW)
      );
      drain();
    }
    addon.voiceActivityDetectorFlush(vad);
    drain();
    return parts.join(" ");
  }

  return {
    transcribeWav(wav: Uint8Array): { text: string; audioSeconds: number } {
      const parsed = parseWav16kMono(wav);
      if (!parsed.ok) throw new Error(`invalid audio: ${parsed.error}`);
      const samples = pcm16ToFloat32(wav, parsed.dataOffset, parsed.dataBytes);
      return { text: transcribeSamples(samples), audioSeconds: parsed.seconds };
    },
  };
}

export type VoiceEngine = ReturnType<typeof createVoiceEngine>;

/** Serve NDJSON requests from `lines` until it ends. */
export async function runVoiceEngineLoop(
  engine: VoiceEngine,
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  now: () => number = () => performance.now()
): Promise<void> {
  write(JSON.stringify({ type: "ready" }));
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    let id = -1;
    try {
      const request = VoiceWorkerRequestSchema.parse(JSON.parse(raw));
      id = request.id;
      const started = now();
      const wav = Uint8Array.from(Buffer.from(request.wavB64, "base64"));
      const { text, audioSeconds } = engine.transcribeWav(wav);
      write(
        JSON.stringify({
          id,
          ok: true,
          text,
          audioSeconds,
          decodeMs: Math.round(now() - started),
        })
      );
    } catch (error) {
      write(
        JSON.stringify({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
}

export function parseVoiceEngineArgs(args: string[]): {
  addonDir: string;
  modelDir: string;
  vadFile: string;
  threads: number;
} {
  const get = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const addonDir = get("--addon-dir");
  const modelDir = get("--model-dir");
  const vadFile = get("--vad");
  if (!addonDir || !modelDir || !vadFile) {
    throw new Error(
      "usage: hapi voice-engine --addon-dir <dir> --model-dir <dir> --vad <file> [--threads N]"
    );
  }
  const threads = Number(get("--threads") ?? 2);
  return {
    addonDir,
    modelDir,
    vadFile,
    threads:
      Number.isInteger(threads) && threads >= 1 && threads <= 8 ? threads : 2,
  };
}

export const voiceEngineCommand: CommandDefinition = {
  name: "voice-engine",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    try {
      const opts = parseVoiceEngineArgs(commandArgs);
      const addon = loadSherpaAddon(opts.addonDir);
      const engine = createVoiceEngine(addon, opts);
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      await runVoiceEngineLoop(engine, rl, line => {
        process.stdout.write(`${line}\n`);
      });
      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `voice-engine: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    }
  },
};
