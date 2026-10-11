// SPDX-License-Identifier: AGPL-3.0-only
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  validateSystemJobsRegistry,
  type SystemJob,
  type SystemJobsRegistry,
} from "@hapi/protocol";

import { systemJobsRegistry } from "./registry";

/**
 * Runtime-mutable system-jobs registry store (issue #1536, epic #1534 ruling
 * D4). The committed `registry.ts` const is the FOUNDATION seed; this store
 * layers read/write mutability on top so the SystemJobsService (and, via #1537,
 * the admin UI) can enable/disable/reschedule/rename/delete jobs at runtime.
 *
 * Persistence is a single JSON file at `<dataDir>/system-jobs-registry.json`,
 * written ATOMICALLY (tmp + rename, mode 0o700 dir) per the settings.ts /
 * accountService.ts idiom (R10). No SQLite dependency — the registry is a
 * bounded, dozens-of-entries-at-most manifest.
 *
 * `command` is deliberately NOT runtime-mutable (R9): the primary command
 * injection / RCE vector stays out-of-band in the committed manifest. `patch`
 * accepts only the four safe fields (whitelist, enforced at BOTH the type level
 * and at runtime).
 *
 * Validation runs through the shared `validateSystemJobsRegistry` on every load
 * AND every save, so a hand-edited or corrupt file fails LOUD rather than being
 * silently overwritten.
 */

/** Default filename for the runtime registry under `dataDir`. */
export const SYSTEM_JOBS_REGISTRY_FILENAME = "system-jobs-registry.json";

/**
 * Fields the service/API may PATCH on an existing entry. `command` is excluded
 * (issue #1536 R9). `name`/`node` are identity keys — a rename is modeled as
 * remove + upsert, not an in-place patch.
 */
export type PatchableJobFields = Partial<
  Pick<SystemJob, "description" | "schedule" | "enabled" | "logPath">
>;

export class SystemJobsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, SYSTEM_JOBS_REGISTRY_FILENAME);
  }

  /** Absolute path of the backing JSON file (useful for diagnostics/tests). */
  path(): string {
    return this.filePath;
  }

  /**
   * Load the registry. On first use (file absent), SEED from the committed
   * const and persist it. On unreadable/non-JSON/invalid content, FAIL LOUD —
   * never silently overwrite a corrupt or hand-edited file.
   */
  load(): SystemJobsRegistry {
    if (!existsSync(this.filePath)) {
      this.writeAtomic(systemJobsRegistry);
      return systemJobsRegistry;
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (e) {
      throw new Error(
        `Cannot read system-jobs registry at ${this.filePath}: ${(e as Error).message}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `system-jobs registry at ${this.filePath} is not valid JSON: ${(e as Error).message}`
      );
    }

    const result = validateSystemJobsRegistry(parsed);
    if (!result.ok) {
      throw new Error(
        `system-jobs registry at ${this.filePath} is invalid: ${result.error}`
      );
    }
    return result.registry;
  }

  /** Validate then atomically persist a full registry. */
  save(registry: SystemJobsRegistry): void {
    const result = validateSystemJobsRegistry(registry);
    if (!result.ok) {
      throw new Error(
        `refusing to save invalid system-jobs registry: ${result.error}`
      );
    }
    this.writeAtomic(result.registry);
  }

  /** Insert or replace the entry for (name, node). Returns the new registry. */
  upsert(job: SystemJob): SystemJobsRegistry {
    const registry = this.load();
    const next = registry.filter(
      j => !(j.name === job.name && j.node === job.node)
    );
    next.push(job);
    this.save(next);
    return next;
  }

  /** Remove the (name, node) entry. Returns the new registry. No-op if absent. */
  remove(name: string, node: string): SystemJobsRegistry {
    const registry = this.load();
    const next = registry.filter(j => !(j.name === name && j.node === node));
    this.save(next);
    return next;
  }

  /**
   * Patch mutable fields of the (name, node) entry. Returns the new registry.
   * Throws if the entry does not exist. `command` can NEVER be set here — the
   * field whitelist below is the runtime half of the R9 guarantee (the type
   * `PatchableJobFields` is the compile-time half).
   */
  patch(
    name: string,
    node: string,
    fields: PatchableJobFields
  ): SystemJobsRegistry {
    const registry = this.load();
    const idx = registry.findIndex(j => j.name === name && j.node === node);
    if (idx === -1) {
      throw new Error(`system-job not found: name="${name}" node="${node}"`);
    }

    // R9 runtime whitelist: copy ONLY the four allowed fields. Even if a caller
    // smuggles `command` (or any other key) through an untyped path, it cannot
    // reach the persisted entry.
    const allowed: PatchableJobFields = {};
    if (fields.description !== undefined)
      allowed.description = fields.description;
    if (fields.schedule !== undefined) allowed.schedule = fields.schedule;
    if (fields.enabled !== undefined) allowed.enabled = fields.enabled;
    if (fields.logPath !== undefined) allowed.logPath = fields.logPath;

    const next = registry.slice();
    next[idx] = { ...next[idx], ...allowed };
    this.save(next);
    return next;
  }

  private writeAtomic(registry: SystemJobsRegistry): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2));
    renameSync(tmp, this.filePath);
  }
}
