// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.voice-input` (issue #4707, epic #4706).
 *
 * Wires the installer, the on-node Parakeet engine (a `hapi voice-engine` child
 * process) and the `/api/voice/*` routes. The engine is never started here — it
 * starts on the first warm-up or transcription and is stopped on shutdown.
 */
import type { ServerRegister } from "@hapi/protocol/ext";
import type { ErrorLogger } from "../../logging/errorLogger";
import { isBunCompiled } from "../../utils/bunCompiled";
import {
  loadVoiceInputConfig,
  saveVoiceInputConfig,
  type VoiceInputConfig,
} from "./config";
import { LocalParakeetEngine, VoiceEngineError } from "./engineManager";
import { VoiceInstaller } from "./installer";
import { ENGINE_NOT_INSTALLED_MESSAGE, createVoiceRoutes } from "./routes";

interface VoiceCoreConfig {
  dataDir: string;
}

/**
 * The command prefix that runs the hapi binary. In the compiled binary that is
 * the binary itself; in `bun run dev` it is opt-in via HAPI_VOICE_ENGINE_CMD
 * (a JSON argv array, e.g. ["bun","/path/to/cli/src/index.ts"]).
 */
export function voiceEngineCommandPrefix(
  env: NodeJS.ProcessEnv = process.env,
  compiled: boolean = isBunCompiled()
): string[] {
  if (compiled) return [process.execPath];
  const override = env.HAPI_VOICE_ENGINE_CMD;
  if (override) {
    try {
      const parsed: unknown = JSON.parse(override);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(p => typeof p === "string")
      ) {
        return parsed as string[];
      }
    } catch {
      // fall through
    }
  }
  throw new VoiceEngineError(
    "dev_mode_unsupported",
    "voice transcription needs the compiled hapi binary (or HAPI_VOICE_ENGINE_CMD in dev mode)"
  );
}

export const register: ServerRegister = async host => {
  const coreConfig = host.getCoreConfig() as VoiceCoreConfig | null;
  if (!coreConfig) {
    throw new Error(
      "[builtin.voice-input] coreConfig is unavailable at register()"
    );
  }
  const errorLogger = host.getErrorLogger() as ErrorLogger | null;
  const log = (message: string, error?: unknown) =>
    errorLogger?.warn(
      `${message}: ${error instanceof Error ? error.message : String(error ?? "")}`,
      { category: "voice-input" }
    );

  let config: VoiceInputConfig = await loadVoiceInputConfig(coreConfig.dataDir);
  const installer = new VoiceInstaller();

  const engine = new LocalParakeetEngine({
    idleUnloadMs: () => config.idleUnloadSeconds * 1000,
    launchArgv: () => {
      if (!installer.isInstalled(config.model)) {
        throw new VoiceEngineError(
          "engine_not_installed",
          ENGINE_NOT_INSTALLED_MESSAGE
        );
      }
      const paths = installer.paths;
      return [
        ...voiceEngineCommandPrefix(),
        "voice-engine",
        "--addon-dir",
        paths.addonDir,
        "--model-dir",
        paths.modelDir(config.model),
        "--vad",
        paths.vadFile,
        "--threads",
        String(config.threads),
      ];
    },
  });

  host.routes.add(() =>
    createVoiceRoutes({
      installer,
      engine,
      getConfig: () => config,
      saveConfig: async update => {
        config = await saveVoiceInputConfig(coreConfig.dataDir, update);
        return config;
      },
      log,
    })
  );

  host.lifecycle.onShutdown(async () => {
    await engine.unload();
  });
};
