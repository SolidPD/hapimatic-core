// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice input API (issue #4707). Mounted under /api after the JWT gate.
 *
 * GET    /voice/status          engine state, models, install progress
 * POST   /voice/warm            start loading the engine (recording started)
 * POST   /voice/transcribe      body: audio/wav, 16 kHz mono PCM16 → { text }
 * POST   /voice/engine/install  { model? } → 202, installs in the background
 * DELETE /voice/engine          unload + delete the downloaded files
 * PUT    /voice/settings        { model?, idleUnloadSeconds?, threads? }
 */
import { Hono, type Context } from "hono";
import { defineCapability } from "@hapi/protocol";
import {
  VOICE_MAX_UPLOAD_BYTES,
  VOICE_MODEL_IDS,
  VoiceInstallRequestSchema,
  VoiceSettingsUpdateSchema,
  parseWav16kMono,
  type VoiceErrorCode,
  type VoiceStatusResponse,
} from "@hapi/protocol/voice";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../../web/middleware/auth";
import { VOICE_ATTRIBUTION, VOICE_MODELS } from "./artifacts";
import type { VoiceInputConfig } from "./config";
import { VoiceEngineError, type TranscriptionEngine } from "./engineManager";
import type { VoiceInstaller } from "./installer";

export const ENGINE_NOT_INSTALLED_MESSAGE =
  "The voice engine is not installed. Install it in Settings → Preferences → Voice input.";

export function unsupportedPlatformMessage(): string {
  return `The on-node speech engine is not available for ${process.platform}-${process.arch}.`;
}

export interface VoiceRoutesDeps {
  installer: VoiceInstaller;
  engine: TranscriptionEngine;
  getConfig: () => VoiceInputConfig;
  saveConfig: (update: Partial<VoiceInputConfig>) => Promise<VoiceInputConfig>;
  log?: (message: string, error?: unknown) => void;
}

function fail(
  c: Context<WebAppEnv>,
  code: VoiceErrorCode,
  error: string,
  status: 400 | 409 | 413 | 429 | 500 | 503
) {
  return c.json({ ok: false, error, code }, status);
}

export function buildVoiceStatus(deps: VoiceRoutesDeps): VoiceStatusResponse {
  const { installer, engine } = deps;
  const config = deps.getConfig();
  const models = VOICE_MODEL_IDS.map(id => ({
    id,
    label: VOICE_MODELS[id].label,
    languages: VOICE_MODELS[id].languages,
    downloadBytes: VOICE_MODELS[id].artifact.bytes,
    installed: installer.isModelInstalled(id),
  }));
  const base = {
    available: true as const,
    engine: "parakeet-local" as const,
    model: config.model,
    models,
    idleUnloadSeconds: config.idleUnloadSeconds,
    threads: config.threads,
    attribution: VOICE_ATTRIBUTION,
  };
  if (!installer.platformSupported) {
    return {
      ...base,
      state: "error",
      error: unsupportedPlatformMessage(),
    };
  }
  const progress = installer.progress;
  if (progress) return { ...base, state: "installing", install: progress };
  if (!installer.isInstalled(config.model)) {
    return {
      ...base,
      state: "not_installed",
      ...(installer.error ? { error: installer.error } : {}),
    };
  }
  const runtime = engine.runtimeState();
  if (runtime === "error") {
    return {
      ...base,
      state: "error",
      error: engine.lastError() ?? "speech engine failed",
    };
  }
  return {
    ...base,
    state:
      runtime === "loading"
        ? "loading"
        : runtime === "loaded"
          ? "loaded"
          : "installed",
  };
}

export function createVoiceRoutes(deps: VoiceRoutesDeps): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const log = deps.log ?? (() => {});

  app.get(
    "/voice/status",
    cataloged(
      defineCapability({
        id: "ui.voice-status",
        domain: "ui",
        surface: "rest",
        description: "Read the voice input engine's install and load state.",
        whenToUse:
          "When the UI decides whether to show the mic button or the voice settings.",
        invocation: { kind: "rest", method: "GET", path: "/api/voice/status" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => c.json(buildVoiceStatus(deps))
  );

  app.post(
    "/voice/warm",
    cataloged(
      defineCapability({
        id: "ui.voice-warm",
        domain: "ui",
        surface: "rest",
        description:
          "Start loading the on-node speech engine ahead of a transcription.",
        whenToUse:
          "When the user starts recording, so the model loads while they speak.",
        invocation: { kind: "rest", method: "POST", path: "/api/voice/warm" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    c => {
      if (deps.installer.isInstalled(deps.getConfig().model)) {
        void deps.engine
          .warm()
          .catch(error => log("voice warm-up failed", error));
      }
      return c.json({ ok: true }, 202);
    }
  );

  app.post(
    "/voice/transcribe",
    cataloged(
      defineCapability({
        id: "ui.voice-transcribe",
        domain: "ui",
        surface: "rest",
        description:
          "Transcribe a 16 kHz mono WAV recording to text on this node.",
        whenToUse: "When the user stops a voice recording in the composer.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/voice/transcribe",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > VOICE_MAX_UPLOAD_BYTES) {
        return fail(
          c,
          "audio_too_large",
          "recording is too large (5 minutes maximum)",
          413
        );
      }
      const config = deps.getConfig();
      if (!deps.installer.isInstalled(config.model)) {
        return fail(
          c,
          "engine_not_installed",
          ENGINE_NOT_INSTALLED_MESSAGE,
          503
        );
      }
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.byteLength > VOICE_MAX_UPLOAD_BYTES) {
        return fail(
          c,
          "audio_too_large",
          "recording is too large (5 minutes maximum)",
          413
        );
      }
      const parsed = parseWav16kMono(body);
      if (!parsed.ok)
        return fail(c, "invalid_audio", `invalid audio: ${parsed.error}`, 400);
      try {
        return c.json(await deps.engine.transcribe(body, parsed.seconds));
      } catch (error) {
        if (error instanceof VoiceEngineError) {
          if (error.code === "engine_unavailable")
            log("voice transcription failed", error);
          return fail(c, error.code, error.message, error.status);
        }
        log("voice transcription failed", error);
        return fail(c, "engine_unavailable", "transcription failed", 500);
      }
    }
  );

  app.post(
    "/voice/engine/install",
    cataloged(
      defineCapability({
        id: "harness-admin.voice-engine-install",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Download and install the on-node speech engine and model.",
        whenToUse: "When the user installs voice input from Settings.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/voice/engine/install",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = VoiceInstallRequestSchema.safeParse(raw ?? {});
      if (!parsed.success)
        return fail(c, "invalid_request", "invalid install request", 400);
      if (!deps.installer.platformSupported) {
        return fail(
          c,
          "unsupported_platform",
          unsupportedPlatformMessage(),
          400
        );
      }
      if (deps.installer.installing) {
        return fail(
          c,
          "install_in_progress",
          "an install is already running",
          409
        );
      }
      const model = parsed.data.model ?? deps.getConfig().model;
      const run = async () => {
        if (model !== deps.getConfig().model) await deps.saveConfig({ model });
        await deps.engine.unload();
        await deps.installer.install(model);
      };
      // This route answers before the install runs, so the status route is
      // the only place the user sees a failure: record every one there.
      void run().catch(error => {
        log("voice engine install failed", error);
        deps.installer.reportError(
          error instanceof Error ? error.message : String(error)
        );
      });
      return c.json({ ok: true, model }, 202);
    }
  );

  app.delete(
    "/voice/engine",
    cataloged(
      defineCapability({
        id: "harness-admin.voice-engine-remove",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Unload the speech engine and delete its downloaded files.",
        whenToUse:
          "When the user removes voice input from Settings to free disk space.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/voice/engine",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    async c => {
      if (deps.installer.installing) {
        return fail(c, "install_in_progress", "an install is running", 409);
      }
      await deps.engine.unload();
      await deps.installer.remove();
      return c.json({ ok: true });
    }
  );

  app.put(
    "/voice/settings",
    cataloged(
      defineCapability({
        id: "harness-admin.voice-settings",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Change the voice input model, idle unload period or thread count.",
        whenToUse: "When the user edits Settings → Voice input.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/voice/settings",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const raw = await c.req.json().catch(() => null);
      const parsed = VoiceSettingsUpdateSchema.safeParse(raw);
      if (!parsed.success)
        return fail(c, "invalid_request", "invalid voice settings", 400);
      const before = deps.getConfig();
      let after: VoiceInputConfig;
      try {
        after = await deps.saveConfig(parsed.data);
      } catch (error) {
        log("voice settings save failed", error);
        return fail(
          c,
          "settings_unreadable",
          error instanceof Error ? error.message : String(error),
          500
        );
      }
      if (after.model !== before.model || after.threads !== before.threads) {
        await deps.engine.unload();
      }
      return c.json(buildVoiceStatus(deps));
    }
  );

  return app;
}
