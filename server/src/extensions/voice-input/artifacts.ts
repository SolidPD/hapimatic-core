// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pinned download artifacts for the on-node voice engine (issue #4707).
 *
 * Nothing native ships inside the hapi binary: the installer downloads the
 * sherpa-onnx Node addon (per CPU arch, from the npm registry), the Parakeet
 * model and the Silero VAD model, and verifies each against the sha256 pinned
 * here before using it. Bumping a version means updating the URL, size and
 * hash together — an unpinned artifact is never installed.
 */
import type { VoiceModelId } from "@hapi/protocol/voice";

export const ENGINE_VERSION = "sherpa-onnx-1.13.8";

export const VOICE_ATTRIBUTION =
  "Speech model: NVIDIA Parakeet TDT 0.6B (CC-BY-4.0), run with sherpa-onnx (Apache-2.0).";

export type ArtifactFormat = "tgz" | "tbz2" | "file";

export interface VoiceArtifact {
  /** Short name used in progress and error messages. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  format: ArtifactFormat;
}

const RELEASES =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

/** sherpa-onnx Node addon (Node-API module + onnxruntime shared libs). */
export const ADDON_ARTIFACTS: Partial<Record<string, VoiceArtifact>> = {
  "linux-arm64": {
    name: "speech engine (linux-arm64)",
    url: "https://registry.npmjs.org/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-1.13.8.tgz",
    sha256: "e1671ad6e94e51947229a5736d06022780f3fba967da8d917173cd9765902ee8",
    bytes: 13_910_679,
    format: "tgz",
  },
  "linux-x64": {
    name: "speech engine (linux-x64)",
    url: "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.8.tgz",
    sha256: "13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c",
    bytes: 11_089_653,
    format: "tgz",
  },
};

export const VAD_ARTIFACT: VoiceArtifact = {
  name: "voice activity detector",
  url: `${RELEASES}/silero_vad.onnx`,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
  bytes: 643_854,
  format: "file",
};

export interface VoiceModelSpec {
  id: VoiceModelId;
  label: string;
  languages: string;
  artifact: VoiceArtifact;
}

export const VOICE_MODELS: Record<VoiceModelId, VoiceModelSpec> = {
  "parakeet-tdt-0.6b-v2-int8": {
    id: "parakeet-tdt-0.6b-v2-int8",
    label: "Parakeet v2 (English)",
    languages: "English",
    artifact: {
      name: "Parakeet v2 model",
      url: `${RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`,
      sha256:
        "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
      bytes: 482_468_385,
      format: "tbz2",
    },
  },
  "parakeet-tdt-0.6b-v3-int8": {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet v3 (25 European languages)",
    languages: "25 European languages",
    artifact: {
      name: "Parakeet v3 model",
      url: `${RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
      sha256:
        "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
      bytes: 487_170_055,
      format: "tbz2",
    },
  },
};

/** `linux-arm64` style key for the running platform. */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  return `${platform}-${arch}`;
}

export function addonArtifactFor(key: string = platformKey()) {
  return ADDON_ARTIFACTS[key] ?? null;
}
