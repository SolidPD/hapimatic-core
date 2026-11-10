// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { JobRegistry } from "@hapi/protocol";
import type { Settings } from "../config/settings";
import type { ErrorLogger } from "../logging/errorLogger";
import type { Store } from "../store";
import type { SyncEngine } from "../sync/syncEngine";
import { loadCacheKeepaliveConfig, type CacheKeepaliveConfig } from "./config";
import { CacheKeepaliveService } from "./service";

/**
 * Prompt-cache keep-alive boot module (issue #6169, epic #6163 Sub C2).
 *
 * `start()` (once, from `index.ts`, after the throughput loops) builds the
 * service and starts its loop; `stop()` stops it before the store closes. The
 * loop is registered even when the feature is off, so System Jobs shows it, and
 * each tick re-reads `settings.json`, so `"enabled": false` there needs no
 * restart (the env var changes only with the server's environment, at a
 * restart). An unreadable settings file keeps the last good configuration (the
 * boot settings at first), so a broken file never switches the feature back
 * on, and its parse error is logged once rather than every minute. Fail-soft: a
 * failure here is logged and never blocks boot.
 */

let service: CacheKeepaliveService | null = null;

/** `{}` for a missing file, the parsed settings, or null when unreadable. */
async function readSettingsQuietly(
  file: string
): Promise<{ settings: Settings | null; error: string | null }> {
  if (!existsSync(file)) return { settings: {}, error: null };
  try {
    return { settings: JSON.parse(await readFile(file, "utf8")), error: null };
  } catch (error) {
    return {
      settings: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function start(opts: {
  settingsFile: string;
  /** The settings read at boot: the first "last good" configuration. */
  bootSettings: Settings | null;
  jobNodeId: string;
  jobRegistry: JobRegistry;
  syncEngine: SyncEngine;
  store: Store;
  errorLogger: ErrorLogger;
  /** Late-bound: the context-watermark service is built after the sync engine. */
  isHandoffHeld: (sessionId: string) => boolean;
}): void {
  try {
    let lastGood: CacheKeepaliveConfig = loadCacheKeepaliveConfig({
      settings: opts.bootSettings,
    });
    let unreadable = false;
    const loadConfig = async (): Promise<CacheKeepaliveConfig> => {
      const { settings, error } = await readSettingsQuietly(opts.settingsFile);
      if (settings === null) {
        if (!unreadable) {
          unreadable = true;
          console.warn(
            `[cache-keepalive] settings.json unreadable, keeping the last good configuration (enabled=${lastGood.enabled}): ${error}`
          );
        }
        return lastGood;
      }
      unreadable = false;
      lastGood = loadCacheKeepaliveConfig({ settings });
      return lastGood;
    };
    service = new CacheKeepaliveService({
      engine: opts.syncEngine,
      ledger: opts.store.throughputKeepalive,
      loadConfig,
      isHandoffHeld: opts.isHandoffHeld,
      nodeId: opts.jobNodeId,
      jobRegistry: opts.jobRegistry,
      errorLogger: opts.errorLogger,
    });
    service.start();
  } catch (error) {
    console.error("[cache-keepalive] failed to start:", error);
    opts.errorLogger.error(
      `[cache-keepalive] failed to start: ${error instanceof Error ? error.message : String(error)}`,
      { category: "cache-keepalive" }
    );
  }
}

export function stop(): void {
  service?.stop();
  service = null;
}
