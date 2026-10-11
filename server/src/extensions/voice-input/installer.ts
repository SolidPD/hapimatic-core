// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Installer for the on-node voice engine (issue #4707).
 *
 * Downloads the pinned artifacts (addon, model, VAD), verifies each sha256
 * BEFORE extracting it, and moves the result into place atomically with a
 * `.complete` marker written last. Files live in ONE per-user directory shared
 * by every Hapimatic instance on the node (prod, dev, worktree instances), so
 * the ~650 MB model is stored once:
 *
 *   $HAPI_VOICE_DIR  or  ${XDG_CACHE_HOME:-~/.cache}/hapimatic/voice
 *     <ENGINE_VERSION>/addon/      sherpa-onnx.node + libonnxruntime.so …
 *     models/<modelId>/            encoder/decoder/joiner .onnx + tokens.txt
 *     vad/silero_vad.onnx
 *
 * One install runs at a time. A second request in the same instance fails
 * with "install already running"; another instance holding the O_EXCL lock
 * file makes the install fail with a recorded error rather than wait. A lock
 * older than 30 minutes is treated as stale. Every failure is kept in `error`
 * for the status route, because the install route answers before it runs.
 *
 * `remove()` deletes only the entries listed in MANAGED_ENTRIES, never the
 * root itself unless it is left empty, because HAPI_VOICE_DIR is used as-is
 * and may point at a folder that holds other files.
 */
import { createHash } from "node:crypto";
import { existsSync, closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { mkdir, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileSink } from "bun";
import type { VoiceInstallProgress, VoiceModelId } from "@hapi/protocol/voice";
import {
  ENGINE_VERSION,
  VAD_ARTIFACT,
  VOICE_MODELS,
  addonArtifactFor,
  type VoiceArtifact,
} from "./artifacts";

const LOCK_STALE_MS = 30 * 60 * 1000;
const COMPLETE_MARKER = ".complete";
const LOCK_FILE = ".install.lock";

/** Root entries the installer creates; `remove()` deletes only these. */
function isManagedEntry(name: string): boolean {
  return (
    name === "models" ||
    name === "vad" ||
    name === LOCK_FILE ||
    name === ENGINE_VERSION ||
    /^\.tmp-\d+-[a-z0-9]{1,6}$/.test(name)
  );
}

export function voiceRootDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HAPI_VOICE_DIR) return env.HAPI_VOICE_DIR;
  const cache = env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "hapimatic", "voice");
}

export interface VoicePaths {
  root: string;
  addonDir: string;
  vadDir: string;
  vadFile: string;
  modelDir: (id: VoiceModelId) => string;
}

export function voicePaths(root: string): VoicePaths {
  return {
    root,
    addonDir: join(root, ENGINE_VERSION, "addon"),
    vadDir: join(root, "vad"),
    vadFile: join(root, "vad", "silero_vad.onnx"),
    modelDir: id => join(root, "models", id),
  };
}

export class VoiceInstallError extends Error {}

/**
 * Bun's FileSink with `write()` typed as it behaves at runtime. bun-types
 * declares `number`, but a write that flushes returns a Promise, and that
 * Promise rejects when the disk is full (#4753).
 */
export type DownloadSink = Omit<FileSink, "write"> & {
  write(chunk: Uint8Array): number | Promise<number>;
};

export interface VoiceInstallerDeps {
  root?: string;
  fetchImpl?: typeof fetch;
  /** Opens the sink a download is written to; defaults to `Bun.file(path).writer()`. */
  fileWriter?: (path: string) => DownloadSink;
  /** Override for tests; defaults to the pinned artifact for this platform. */
  addonArtifact?: VoiceArtifact | null;
  vadArtifact?: VoiceArtifact;
  modelArtifact?: (id: VoiceModelId) => VoiceArtifact;
}

export class VoiceInstaller {
  readonly paths: VoicePaths;
  private readonly fetchImpl: typeof fetch;
  private readonly fileWriter: (path: string) => DownloadSink;
  private readonly addonArtifact: VoiceArtifact | null;
  private readonly vadArtifact: VoiceArtifact;
  private readonly modelArtifact: (id: VoiceModelId) => VoiceArtifact;
  private current: VoiceInstallProgress | null = null;
  private lastError: string | null = null;

  constructor(deps: VoiceInstallerDeps = {}) {
    this.paths = voicePaths(deps.root ?? voiceRootDir());
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.fileWriter = deps.fileWriter ?? (path => Bun.file(path).writer());
    this.addonArtifact =
      deps.addonArtifact === undefined
        ? addonArtifactFor()
        : deps.addonArtifact;
    this.vadArtifact = deps.vadArtifact ?? VAD_ARTIFACT;
    this.modelArtifact =
      deps.modelArtifact ?? (id => VOICE_MODELS[id].artifact);
  }

  get platformSupported(): boolean {
    return this.addonArtifact !== null;
  }

  get progress(): VoiceInstallProgress | null {
    return this.current;
  }

  get installing(): boolean {
    return this.current !== null;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Record a failure that stopped an install before `install()` ran. */
  reportError(message: string): void {
    this.lastError = message;
  }

  isAddonInstalled(): boolean {
    return existsSync(join(this.paths.addonDir, COMPLETE_MARKER));
  }

  isVadInstalled(): boolean {
    return existsSync(join(this.paths.vadDir, COMPLETE_MARKER));
  }

  isModelInstalled(id: VoiceModelId): boolean {
    return existsSync(join(this.paths.modelDir(id), COMPLETE_MARKER));
  }

  isInstalled(id: VoiceModelId): boolean {
    return (
      this.isAddonInstalled() &&
      this.isVadInstalled() &&
      this.isModelInstalled(id)
    );
  }

  /**
   * Download + verify + install whatever is missing for `id`. Resolves when
   * done; rejects with VoiceInstallError on any failure (nothing half-installed
   * is left behind — the `.complete` marker is written last).
   */
  async install(id: VoiceModelId): Promise<void> {
    if (!this.addonArtifact) {
      throw new VoiceInstallError(
        `voice engine is not available for ${process.platform}-${process.arch}`
      );
    }
    if (this.current) throw new VoiceInstallError("install already running");
    const steps: Array<{
      artifact: VoiceArtifact;
      dest: string;
      done: boolean;
    }> = [
      {
        artifact: this.addonArtifact,
        dest: this.paths.addonDir,
        done: this.isAddonInstalled(),
      },
      {
        artifact: this.vadArtifact,
        dest: this.paths.vadDir,
        done: this.isVadInstalled(),
      },
      {
        artifact: this.modelArtifact(id),
        dest: this.paths.modelDir(id),
        done: this.isModelInstalled(id),
      },
    ];
    const todo = steps.filter(s => !s.done);
    if (todo.length === 0) return;

    const total = todo.reduce((sum, s) => sum + s.artifact.bytes, 0);
    this.current = { phase: "starting", bytesDone: 0, bytesTotal: total };
    this.lastError = null;
    let lock: { release: () => void } | null = null;
    let base = 0;
    try {
      // Inside the try: a failure here must clear `current` and be recorded,
      // or the status reads "installing" until the server restarts.
      await mkdir(this.paths.root, { recursive: true });
      lock = this.acquireLock();
      for (const step of todo) {
        await this.installArtifact(step.artifact, step.dest, base, total);
        base += step.artifact.bytes;
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error instanceof VoiceInstallError
        ? error
        : new VoiceInstallError(this.lastError);
    } finally {
      this.current = null;
      lock?.release();
    }
  }

  /** Remove a model; removes the addon and VAD too when no model remains. */
  async remove(id?: VoiceModelId): Promise<void> {
    if (this.current) throw new VoiceInstallError("install already running");
    if (id) {
      await rm(this.paths.modelDir(id), { recursive: true, force: true });
      const modelsDir = join(this.paths.root, "models");
      const left = existsSync(modelsDir) ? await readdir(modelsDir) : [];
      if (left.length > 0) return;
    }
    if (!existsSync(this.paths.root)) return;
    for (const name of await readdir(this.paths.root)) {
      if (isManagedEntry(name)) {
        await rm(join(this.paths.root, name), { recursive: true, force: true });
      }
    }
    // Drop the root only when nothing else lives there.
    await rmdir(this.paths.root).catch(() => {});
  }

  private acquireLock(): { release: () => void } {
    const lockPath = join(this.paths.root, LOCK_FILE);
    const tryOpen = () => {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
    };
    try {
      tryOpen();
    } catch {
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) {
        throw new VoiceInstallError(
          "another Hapimatic instance is installing the voice engine"
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone
      }
      try {
        tryOpen();
      } catch {
        throw new VoiceInstallError("could not take the voice install lock");
      }
    }
    return {
      release: () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      },
    };
  }

  private async installArtifact(
    artifact: VoiceArtifact,
    dest: string,
    base: number,
    total: number
  ): Promise<void> {
    const tmp = join(
      this.paths.root,
      `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    await mkdir(tmp, { recursive: true });
    try {
      const download = join(tmp, "download");
      await this.download(artifact, download, base, total);
      if (this.current)
        this.current = {
          ...this.current,
          phase: `installing ${artifact.name}`,
        };
      const staged = join(tmp, "staged");
      await mkdir(staged, { recursive: true });
      if (artifact.format === "file") {
        const name = artifact.url.split("/").pop() ?? "artifact";
        await rename(download, join(staged, name));
      } else {
        await extract(download, staged, artifact.format);
      }
      const content = await singleTopDir(staged);
      await writeFile(join(content, COMPLETE_MARKER), `${artifact.sha256}\n`);
      await rm(dest, { recursive: true, force: true });
      await mkdir(join(dest, ".."), { recursive: true });
      await rename(content, dest);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async download(
    artifact: VoiceArtifact,
    file: string,
    base: number,
    total: number
  ): Promise<void> {
    this.current = {
      phase: `downloading ${artifact.name}`,
      bytesDone: base,
      bytesTotal: total,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(artifact.url);
    } catch (error) {
      throw new VoiceInstallError(
        `download of ${artifact.name} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok || !response.body) {
      throw new VoiceInstallError(
        `download of ${artifact.name} failed: HTTP ${response.status}`
      );
    }
    const hash = createHash("sha256");
    const writer = this.fileWriter(file);
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        // Awaited: on a full disk the write's Promise rejects (ENOSPC). Left
        // unawaited that rejection is unhandled and exits the server, which
        // installs no unhandledRejection handler.
        await writer.write(chunk);
        received += chunk.byteLength;
        this.current = {
          phase: `downloading ${artifact.name}`,
          bytesDone: base + Math.min(received, artifact.bytes),
          bytesTotal: total,
        };
      }
    } finally {
      await writer.end();
    }
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) {
      throw new VoiceInstallError(
        `${artifact.name} failed its checksum (expected ${artifact.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`
      );
    }
  }
}

async function extract(
  archive: string,
  into: string,
  format: "tgz" | "tbz2"
): Promise<void> {
  const flag = format === "tgz" ? "-xzf" : "-xjf";
  const proc = Bun.spawn(["tar", flag, archive, "-C", into], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new VoiceInstallError(
      `could not unpack ${archive.split("/").pop()}: ${stderr.trim().slice(0, 300) || `tar exit ${code}`}`
    );
  }
}

/**
 * Archives wrap their content in one top-level directory (`package/` for npm,
 * `sherpa-onnx-…/` for models). Return that directory, or `dir` itself when
 * the content is not wrapped.
 */
async function singleTopDir(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    return join(dir, entries[0]!.name);
  }
  return dir;
}
