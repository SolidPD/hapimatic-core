// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Boot-time self-knowledge self-heal writer (issue #3873, epic #3740).
 *
 * The generated `~/.claude/agent-self-knowledge.md` (Tier-1 rendering, #3750) is
 * a BUILD-TIME static file: `bun run gen:capabilities` renders it in-repo and
 * `reconcile-vm.sh --surface agent-self-knowledge` scp's it to each VM. It has no
 * runtime importer, and the VM auto-update pipeline (`update-hapimatic.sh`) ships
 * the BINARY only — never re-pushes the doc. So after any binary auto-update the
 * on-VM doc goes STALE relative to the running binary (older capability set, older
 * version stamp).
 *
 * This module is the missing AUTO-HEAL: it (re)generates the doc at SERVER BOOT
 * from the running binary's own compiled capability catalog + embedded preamble +
 * `VERSION`. Because every binary update restarts the server, the doc is fresh BY
 * CONSTRUCTION — on every update, every fresh provision, and every non-update
 * restart. The #3747 detection sweep + `check:capabilities-gen-clean` become a
 * backstop that should report ~zero drift.
 *
 * DESIGN CONSTRAINTS (from the #3873 directive):
 *  - R2  — the `hapimatic-version:` stamp equals the running `VERSION` (substituted
 *          exactly as `provision-helpers.sh:228` does).
 *  - R3  — node-level scope, fail-closed to `user`; reuse ONLY the host-proof half
 *          of `deriveScope` (its caller-proof is per-request, absent at boot).
 *  - R4  — write the doc ONLY; never read/edit `~/.claude/CLAUDE.md` (#3750 OR-2 —
 *          the `@`-include is owned by `provision.sh`/`ensure_agent_self_knowledge_include`).
 *  - R5  — FAIL-SOFT: any error logs via `ErrorLogger` and is swallowed. A doc
 *          defect must never crash server boot (mirrors `catalogCollector`).
 *  - R6  — byte-identical to `gen:capabilities` for the scope (the compiled-in
 *          `capabilityCatalogIndex` + the embedded `SELF_KNOWLEDGE_PREAMBLE` are
 *          the SAME sources the committed `.md` was rendered from).
 */
import { homedir } from "node:os";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  capabilityCatalogIndex,
  renderSelfKnowledge,
  SELF_KNOWLEDGE_PREAMBLE,
  type CatalogEntry,
  type SelfKnowledgeScope,
} from "@hapi/protocol";
import { VERSION } from "../version.generated";
import { evaluateCapability } from "../provisioner/capability";
import { readVmTier } from "../web/desktopProxy";
import type { ErrorLogger } from "../logging/errorLogger";

/** ErrorLogger category for boot self-heal events (rate-limited per category). */
export const SELF_KNOWLEDGE_LOG_CATEGORY = "self-knowledge-boot";

/**
 * The literal version placeholder the pure renderer emits (R1b). The committed
 * `.md` retains it; each push/boot substitutes the running version — the same
 * `sed "s|__HAPIMATIC_VERSION__|${version}|g"` provision-helpers.sh:228 uses.
 */
const VERSION_PLACEHOLDER = "__HAPIMATIC_VERSION__";

/**
 * Explicit scope override env (OR-A). When set by `provision.sh` from the same
 * `is_operator_subdomain` decision `reconcile-vm.sh` uses, it is the authoritative
 * scope signal — single source of truth vs. the out-of-band allowlist the binary
 * cannot read. Absent ⇒ fall back to the host-proof primitives.
 */
const SCOPE_ENV = "HAPI_SELF_KNOWLEDGE_SCOPE";

/**
 * Injectable dependencies (every default hits the real host / real fs / compiled
 * catalog). The test injects all of them so it never touches the real `~/.claude`.
 */
export interface BootSelfKnowledgeDeps {
  /** Where fail-soft errors are logged (null in a minimal/test context). */
  readonly errorLogger?: ErrorLogger | null;
  /** Env source for the explicit scope override (default `process.env`). */
  readonly env?: Record<string, string | undefined>;
  /** The compiled-in catalog (default: the committed `capabilityCatalogIndex`). */
  readonly entries?: readonly CatalogEntry[];
  /** The embedded preamble text (default: the generated `SELF_KNOWLEDGE_PREAMBLE`). */
  readonly preamble?: string;
  /** Running binary version (default: `VERSION`). */
  readonly version?: string;
  /** Host proof — `true` iff this is a provisioner host (default: `evaluateCapability(...).enabled`). */
  readonly hostProofEnabled?: () => boolean;
  /** Customer VM-tier marker — present on customer VMs, absent on operator hosts. */
  readonly vmTier?: () => string | undefined;
  /** Home dir (default: `os.homedir()`) — injected so tests never touch real `~/.claude`. */
  readonly homeDir?: string;
}

/** Default host proof — the fail-closed provisioner verdict on this box (R3). */
function defaultHostProofEnabled(): boolean {
  return evaluateCapability({
    repoRoot: process.env.HAPI_VM_REPO_ROOT ?? process.cwd(),
  }).enabled;
}

/**
 * Resolve the node-level render scope (R3). Precedence:
 *   1. explicit `HAPI_SELF_KNOWLEDGE_SCOPE` env (`operator`|`user`) — authoritative;
 *   2. host proof — `operator` iff `hostProofEnabled()` AND `vmTier() === undefined`
 *      (a customer can delete its own tier marker but cannot manufacture `~/.oci`
 *      creds + the provisioning scripts);
 *   3. `user` — the fail-closed default on any doubt.
 * This is `deriveScope`'s host-proof half ONLY — its caller proof is per-request
 * and there is no caller at boot.
 */
export function resolveBootScope(
  deps: BootSelfKnowledgeDeps = {}
): SelfKnowledgeScope {
  const env = deps.env ?? process.env;
  const override = env[SCOPE_ENV]?.trim().toLowerCase();
  if (override === "operator" || override === "user") return override;

  const hostProofEnabled = deps.hostProofEnabled ?? defaultHostProofEnabled;
  const vmTier = deps.vmTier ?? readVmTier;
  if (hostProofEnabled() && vmTier() === undefined) return "operator";
  return "user";
}

/**
 * (Re)generate `~/.claude/agent-self-knowledge.md` at server boot. Fail-soft (R5):
 * every step is inside one try/catch that logs and returns — a self-knowledge
 * defect must never crash boot. Writes the doc ONLY (R4). Call this at boot, OFF
 * the request hot path (issue #3873 Task 4).
 */
export async function writeBootSelfKnowledge(
  deps: BootSelfKnowledgeDeps = {}
): Promise<void> {
  const errorLogger = deps.errorLogger;
  let tmp: string | undefined;
  try {
    const scope = resolveBootScope(deps);
    const entries = deps.entries ?? capabilityCatalogIndex;
    const preamble = deps.preamble ?? SELF_KNOWLEDGE_PREAMBLE;
    const version = deps.version ?? VERSION;
    const home = deps.homeDir ?? homedir();

    // Render (R1, R6) then substitute the version stamp (R2). The render is
    // byte-identical to the committed `.md` (which keeps the placeholder); the
    // substitution mirrors provision-helpers.sh's global `sed` replace.
    const rendered = renderSelfKnowledge(entries, scope, preamble).replaceAll(
      VERSION_PLACEHOLDER,
      version
    );

    // Write the doc ONLY (R4) — NEVER `~/.claude/CLAUDE.md`. Atomic (temp +
    // rename on the same dir/filesystem) so a mid-write crash never leaves a
    // truncated doc that the #3747 version-stamp detector would misread.
    const claudeDir = join(home, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const target = join(claudeDir, "agent-self-knowledge.md");
    tmp = join(claudeDir, `.agent-self-knowledge.md.tmp-${process.pid}`);
    await writeFile(tmp, rendered, "utf8");
    await rename(tmp, target);
    tmp = undefined; // renamed into place — nothing to clean up

    console.log(
      `[self-knowledge] wrote ${target} (scope=${scope}, version=${version})`
    );
  } catch (err) {
    errorLogger?.error(
      "self-knowledge boot writer: failed to (re)generate " +
        "~/.claude/agent-self-knowledge.md; leaving any prior doc in place",
      {
        category: SELF_KNOWLEDGE_LOG_CATEGORY,
        context: { error: err instanceof Error ? err.message : String(err) },
      }
    );
    // Best-effort cleanup of a half-written temp (fail-soft — never rethrow).
    if (tmp) {
      try {
        await rm(tmp, { force: true });
      } catch {
        /* ignore — the temp is a hidden dotfile; leaving it is harmless */
      }
    }
  }
}
