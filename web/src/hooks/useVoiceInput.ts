// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice input recording for the composer (issue #4707).
 *
 * Tap to start, tap to stop. The clip is decoded in the browser to a 16 kHz
 * WAV, sent to the node's speech engine, and the text is handed to
 * `onTranscript` — it is never sent as a message.
 *
 * iOS installed web apps ask for the microphone again whenever the stream is
 * re-acquired, so ONE MediaStream is kept while the page is visible (tracks
 * disabled between recordings). When the page is hidden — which also breaks a
 * live stream on iOS (WebKit bug 252465) — any recording is stopped and
 * transcribed (if at least a second long) and the stream is released; the next
 * tap re-acquires it cleanly.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  VOICE_MAX_RECORDING_SECONDS,
  type VoiceStatusResponse,
} from "@hapi/protocol/voice";
import { ApiError, type ApiClient } from "@/api/client";
import { blobToWav16k } from "@/lib/audio/encodeWav16k";
import { queryKeys } from "@/lib/query-keys";
import { useVoiceStatus } from "@/hooks/queries/useVoiceStatus";

export type VoiceInputState =
  | "idle"
  | "acquiring"
  | "recording"
  | "transcribing";

export interface VoiceInputError {
  message: string;
  /** Show a link to Settings → Preferences → Voice input. */
  action?: "settings";
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
const MIN_KEEP_ON_HIDE_MS = 1000;

export function pickRecorderMimeType(
  isTypeSupported: (type: string) => boolean
): string | undefined {
  return MIME_CANDIDATES.find(type => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

export const NOT_INSTALLED_ERROR: VoiceInputError = {
  message:
    "The voice engine isn't installed yet. Install it in Settings → Preferences → Voice input.",
  action: "settings",
};

export const INSTALLING_ERROR: VoiceInputError = {
  message:
    "The voice engine is still installing. Try again when Settings shows it as installed.",
  action: "settings",
};

/** Map a browser or server failure to a message a user can act on. */
export function voiceErrorFor(error: unknown): VoiceInputError {
  if (error instanceof ApiError) {
    const serverMessage = (() => {
      try {
        const parsed = JSON.parse(error.body ?? "") as { error?: unknown };
        return typeof parsed.error === "string" ? parsed.error : null;
      } catch {
        return null;
      }
    })();
    switch (error.code) {
      case "engine_not_installed":
        return NOT_INSTALLED_ERROR;
      case "engine_busy":
        return {
          message: "The voice engine is busy. Try again in a moment.",
        };
      case "insufficient_memory":
        return {
          message:
            serverMessage ??
            "Not enough free memory on this node to load the voice engine.",
        };
      case "audio_too_large":
        return { message: "That recording is too long (5 minutes maximum)." };
      case "invalid_audio":
        return { message: "The recording could not be processed." };
      default:
        return {
          message: `The voice engine is unavailable${serverMessage ? `: ${serverMessage}` : "."}`,
        };
    }
  }
  if (error instanceof DOMException || (error as Error)?.name) {
    switch ((error as Error).name) {
      case "NotAllowedError":
      case "SecurityError":
        return {
          message:
            "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.",
        };
      case "NotFoundError":
      case "OverconstrainedError":
        return { message: "No microphone was found on this device." };
      case "NotReadableError":
        return {
          message: "The microphone is in use by another app.",
        };
      // Embedded web views and headless browsers report a blocked microphone
      // as NotSupportedError rather than NotAllowedError (measured, #4707).
      case "NotSupportedError":
        return {
          message:
            "This browser didn't allow microphone access here. Check the microphone permission for this site, or open Hapimatic in Safari or Chrome.",
        };
      case "AbortError":
        return { message: "The microphone could not be started. Try again." };
      case "EncodingError":
        return { message: "The recording could not be processed." };
      default:
        if (error instanceof DOMException) {
          return {
            message: `The microphone could not be started (${error.name}).`,
          };
        }
        break;
    }
  }
  return {
    message:
      error instanceof Error && error.message
        ? error.message
        : "Voice input failed.",
  };
}

export const INSECURE_ORIGIN_ERROR: VoiceInputError = {
  message:
    "Voice input needs a secure (HTTPS) address. This page was opened over plain http://, so the browser blocks the microphone.",
};

export const NO_SPEECH_ERROR: VoiceInputError = {
  message: "No speech detected.",
};

/**
 * Refuse to record when the engine cannot transcribe, so the user is not left
 * talking for a minute only to be told afterwards. `null` = go ahead.
 */
export function engineBlocker(
  status: VoiceStatusResponse | null | undefined
): VoiceInputError | null {
  if (!status) return null;
  if (status.state === "not_installed") return NOT_INSTALLED_ERROR;
  if (status.state === "installing") return INSTALLING_ERROR;
  if (status.state === "error" && !status.models.some(m => m.installed)) {
    return { message: status.error ?? "The voice engine is unavailable." };
  }
  return null;
}

export function useVoiceInput(opts: {
  api: ApiClient | null;
  onTranscript: (text: string) => void;
}): {
  available: boolean;
  state: VoiceInputState;
  elapsedMs: number;
  error: VoiceInputError | null;
  clearError: () => void;
  toggle: () => void;
  start: () => Promise<void>;
  stop: () => void;
} {
  const { api } = opts;
  const { status, refetch: refetchStatus } = useVoiceStatus(api);
  const queryClient = useQueryClient();
  const [state, setState] = useState<VoiceInputState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<VoiceInputError | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = useRef(false);
  const stateRef = useRef<VoiceInputState>("idle");
  const onTranscriptRef = useRef(opts.onTranscript);
  onTranscriptRef.current = opts.onTranscript;

  const setPhase = useCallback((next: VoiceInputState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stopTicking = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach(track => track.stop());
  }, []);

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (!api) return;
      setPhase("transcribing");
      try {
        if (blob.size === 0) {
          setError(NO_SPEECH_ERROR);
          return;
        }
        const { wav } = await blobToWav16k(blob);
        const result = await api.transcribeVoice(wav);
        const text = result.text.trim();
        if (!text) {
          setError(NO_SPEECH_ERROR);
          return;
        }
        onTranscriptRef.current(text);
      } catch (err) {
        setError(voiceErrorFor(err));
      } finally {
        void queryClient.invalidateQueries({ queryKey: queryKeys.voiceStatus });
        setPhase("idle");
      }
    },
    [api, queryClient, setPhase]
  );

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    stopTicking();
    recorder.stop();
  }, [stopTicking]);

  const start = useCallback(async () => {
    if (!api || stateRef.current !== "idle") return;
    setError(null);
    if (engineBlocker(status)) {
      // The cached status may be stale (installed from another tab): confirm.
      const fresh = await refetchStatus();
      const blocker = engineBlocker(
        (fresh as { data?: VoiceStatusResponse | null }).data ?? status
      );
      if (blocker) {
        setError(blocker);
        return;
      }
    }
    if (
      typeof window !== "undefined" &&
      (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    ) {
      setError(INSECURE_ORIGIN_ERROR);
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError({ message: "This browser cannot record audio." });
      return;
    }
    setPhase("acquiring");
    let stream = streamRef.current;
    const live =
      stream?.getAudioTracks().some(track => track.readyState === "live") ??
      false;
    if (!stream || !live) {
      releaseStream();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        setPhase("idle");
        setError(voiceErrorFor(err));
        return;
      }
      streamRef.current = stream;
      stream.getAudioTracks().forEach(track => {
        track.addEventListener("ended", () => {
          if (streamRef.current !== stream) return;
          const recording = stateRef.current === "recording";
          releaseStream();
          if (recording) {
            discardRef.current = true;
            stopTicking();
            recorderRef.current?.stop();
            setError({
              message: "The microphone stopped. Tap the mic to try again.",
            });
          }
        });
      });
    }
    stream.getAudioTracks().forEach(track => {
      track.enabled = true;
    });

    const mimeType = pickRecorderMimeType(t =>
      MediaRecorder.isTypeSupported(t)
    );
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (err) {
      setPhase("idle");
      setError(voiceErrorFor(err));
      return;
    }
    chunksRef.current = [];
    discardRef.current = false;
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onerror = () => {
      discardRef.current = true;
      stopTicking();
      releaseStream();
      setError({ message: "Recording failed. Tap the mic to try again." });
    };
    recorder.onstop = () => {
      recorderRef.current = null;
      stopTicking();
      streamRef.current?.getAudioTracks().forEach(track => {
        track.enabled = false;
      });
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      chunksRef.current = [];
      if (discardRef.current) {
        discardRef.current = false;
        setPhase("idle");
        return;
      }
      void transcribe(blob);
    };
    recorderRef.current = recorder;
    recorder.start(250);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setPhase("recording");
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= VOICE_MAX_RECORDING_SECONDS * 1000) {
        stopTicking();
        recorderRef.current?.stop();
      }
    }, 250);
    // Load the model while the user speaks; failures surface on transcribe.
    void api.warmVoice().catch(() => {});
  }, [
    api,
    refetchStatus,
    releaseStream,
    setPhase,
    status,
    stopTicking,
    transcribe,
  ]);

  const toggle = useCallback(() => {
    if (stateRef.current === "recording") stop();
    else if (stateRef.current === "idle") void start();
  }, [start, stop]);

  // Page hidden (app backgrounded, screen locked): stop and release.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        if (Date.now() - startedAtRef.current < MIN_KEEP_ON_HIDE_MS) {
          discardRef.current = true;
        }
        stopTicking();
        recorder.stop();
      }
      releaseStream();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [releaseStream, stopTicking]);

  // Unmount: drop any recording and release the microphone.
  useEffect(
    () => () => {
      discardRef.current = true;
      stopTicking();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      releaseStream();
    },
    [releaseStream, stopTicking]
  );

  return {
    available: status !== null,
    state,
    elapsedMs,
    error,
    clearError: () => setError(null),
    toggle,
    start,
    stop,
  };
}
