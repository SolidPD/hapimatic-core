// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * System-jobs registry — Zod schema for the declarative job-registry manifest
 * that drives the idempotent reconciler (issue #1535, epic #1534).
 *
 * Single source of truth for the manifest entry shape. A "system job" is an
 * OS-level scheduled job (a systemd user timer + service pair, preferred; or a
 * crontab entry as a documented fallback) managed declaratively: the registry
 * is the desired state, and the reconciler applies it idempotently.
 *
 * Consumed by:
 * - server/src/systemJobs/reconciler.ts (renders units, plans + applies reconciliation)
 * - server/src/systemJobs/registry.ts (the committed manifest data; first registrant)
 * - Sub-Issue B (#1536) — per-node backend API (read + mutate registry entries)
 * - Sub-Issue D (#1538) — admin-drawer "System Jobs" section UI
 *
 * Shared types live here because they run on ALL federation instances
 * (hub + peer + node) — see docs/internal/architecture/federation.md "Federation Development Rules".
 *
 * This module is PURE — no filesystem, no env reads, no exec. The reconciler
 * (server/src/systemJobs/) owns all I/O. Keeping the schema pure makes it
 * trivially testable and lets the server + web surfaces share identical
 * validation semantics without coupling to a runtime.
 *
 * The seven fields are LOCKED by the issue #1535 acceptance criteria
 * (`name`, `description`, `schedule`, `command`, `enabled`, `logPath`, `node`).
 * `.passthrough()` accepts forward-compatible additions (Sub-Issues B-E may add
 * fields) without breaking older consumers.
 */

/**
 * True if `s` contains any ASCII control character (C0 range 0x00-0x1f or DEL
 * 0x7f). Implemented as a charCode scan rather than a regex literal so the
 * source stays pure-ASCII and unambiguous (a control-char range baked into a
 * `/.../` literal is invisible to grep and fragile under formatters). These
 * are the unit-file directive / managed-marker injection vectors (issue #1536
 * R3, epic #1534 Fable-review ruling D2): a newline in a value that renders into
 * a `.timer`/`.service` unit can inject an extra directive or a spoofed
 * `# HAPImatic-managed:` marker (the D7 cross-node-prune vector). Non-control
 * text (spaces, hyphens, em-dashes, unicode) is intentionally allowed. This is a
 * SHARED guard so the schema protects the API, the standalone runner, and the
 * federation receivers in one place.
 */
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const noControlChars = (label: string) =>
  z
    .string()
    .min(1)
    .refine(s => !hasControlChar(s), {
      message: `${label} must not contain control characters (newline/control = unit-file injection vector)`,
    });

export const SystemJobSchema = z
  .object({
    /** systemd-unit-safe base name → `<name>.timer` + `<name>.service`. The
     *  regex is the first line of injection defense (issue #1536 D2 adds the
     *  64-char cap; the leading-alphanumeric rule rejects `._-`-prefixed and
     *  path-traversal names). Sub-Issue E (#1539) hardens further. */
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/),
    /** Human-readable description → systemd `Description=`. No control chars. */
    description: noControlChars("description"),
    /** A systemd `OnCalendar` expression (e.g. `*-*-* 04:30:00`) → `[Timer]`
     *  `OnCalendar=`. See claudedocs/system-jobs-reconciler.md for the
     *  cron ↔ OnCalendar mapping used by the documented crontab fallback.
     *  No control chars (injection-safe). */
    schedule: noControlChars("schedule"),
    /** Command to run → `[Service]` `ExecStart=`. May contain the `%h` systemd
     *  home-directory specifier. NOT API-mutable (issue #1536 R9) — set
     *  out-of-band in the manifest, so it is not control-char-refined here. */
    command: z.string().min(1),
    /** Whether the job is active. `false` ⇒ reconciler disables + prunes it. */
    enabled: z.boolean().default(true),
    /** Optional log-file path. `null` ⇒ journald (the default). When set, the
     *  reconciler renders `StandardOutput`/`StandardError=append:<logPath>`.
     *  No control chars when non-null (injection-safe). */
    logPath: noControlChars("logPath").nullable().default(null),
    /** Federation `nodeId` this entry targets (matches FederationConfig.nodeId).
     *  The reconciler applies only entries whose `node` matches the current node.
     *  No control chars — a newline here is the D7 marker-spoof vector. */
    node: noControlChars("node"),
  })
  .passthrough();

export type SystemJob = z.infer<typeof SystemJobSchema>;

export const SystemJobsRegistrySchema = z.array(SystemJobSchema);

export type SystemJobsRegistry = z.infer<typeof SystemJobsRegistrySchema>;

export type ValidateRegistryResult =
  | { ok: true; registry: SystemJobsRegistry }
  | { ok: false; error: string };

/**
 * Validate an unknown input against the system-jobs registry schema.
 *
 * Returns `{ok: true, registry}` on success or `{ok: false, error}` with the
 * Zod error message on failure. Never throws.
 */
export function validateSystemJobsRegistry(
  input: unknown
): ValidateRegistryResult {
  const result = SystemJobsRegistrySchema.safeParse(input);
  if (!result.success) return { ok: false, error: result.error.message };

  // Issue #1536 R4 (epic #1534 ruling D2): reject duplicate `(name, node)` pairs.
  // Two entries targeting the same unit on the same node is ambiguous — the
  // reconciler keys desired state by name per node, so a duplicate would
  // silently drop one entry (last-write-wins). The same `name` on DIFFERENT
  // nodes is allowed (each node owns its own `<name>.timer`).
  const seen = new Set<string>();
  for (const job of result.data) {
    // JSON-encode the pair so a node value containing the separator cannot
    // collide with a different (name, node) pair.
    const key = JSON.stringify([job.node, job.name]);
    if (seen.has(key)) {
      return {
        ok: false,
        error: `duplicate (name, node) pair: name="${job.name}" node="${job.node}"`,
      };
    }
    seen.add(key);
  }

  return { ok: true, registry: result.data };
}
