// SPDX-License-Identifier: MIT
/**
 * Runtime systemd-invariants self-check on daemon startup.
 *
 * Verifies the four invariants required to keep Hapimatic tmux/Claude sessions
 * alive across daemon restarts (see hapimatic-private#418):
 *   1. KillMode=process     — daemon-only kill (default control-group SIGTERMs the cgroup)
 *   2. Wants=hapimatic-*    — loose coupling to the parent server unit
 *   3. PartOf=  empty       — no cascade-restart on server stop/start
 *   4. BindsTo= empty       — no cascade-stop on server stop
 *
 * Default behavior: log a warning if any invariant fails.
 * Set HAPI_DAEMON_ENFORCE_SYSTEMD_INVARIANTS=1 (or true/yes) to escalate the
 * warning to a refusal-to-start (process.exit(1)) BEFORE the daemon claims
 * its lock file.
 *
 * Graceful no-op when:
 *   - process.platform !== "linux"
 *   - /proc/self/cgroup unreadable
 *   - cgroup path doesn't include a *.service segment (running outside systemd)
 *   - systemctl unavailable or returns non-zero
 *   - any internal error (parse failure, etc.)
 *
 * Internal failures must NEVER abort the daemon — only the explicit env-var
 * opt-in path may exit. The whole orchestrator body is wrapped in try/catch.
 *
 * Companion to the rp1-home#472 CI gate (Option A) which checks the same
 * invariants at commit time. This module is the runtime drift gate (Option C).
 */

import { readFileSync } from "fs";
import { execFileSync } from "child_process";

import { logger } from "@/ui/logger";

const ENFORCE_ENV_VAR = "HAPI_DAEMON_ENFORCE_SYSTEMD_INVARIANTS";

export interface InvariantsResult {
  ok: boolean;
  failures: string[];
}

/**
 * Parse `KEY=VALUE` lines from `systemctl show` output.
 *
 * - Empty value (`PartOf=`) yields `""` (not undefined).
 * - Lines without `=` are ignored.
 * - Blank lines are ignored.
 * - The first `=` is the separator (a VALUE may contain `=`).
 * - Trailing whitespace is trimmed from VALUE.
 */
export function parseSystemctlShowOutput(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    const value = line.slice(eq + 1).replace(/\s+$/, "");
    result[key] = value;
  }
  return result;
}

/**
 * Validate the four systemd invariants required for tmux/Claude session
 * survival. Pure function — accumulates all failures into the returned array
 * (does not short-circuit on first failure, so the warning lists every
 * problem in one pass).
 */
export function validateInvariants(
  props: Record<string, string>
): InvariantsResult {
  const failures: string[] = [];

  const killMode = props.KillMode ?? "";
  if (killMode !== "process") {
    failures.push(`KillMode must be 'process' (got '${killMode}')`);
  }

  const wantsValue = props.Wants ?? "";
  const wantsTokens = wantsValue.split(/\s+/).filter(t => t !== "");
  if (!wantsTokens.some(token => token.startsWith("hapimatic-"))) {
    failures.push(
      `Wants must contain a hapimatic-* unit (got '${wantsValue}')`
    );
  }

  const partOf = (props.PartOf ?? "").trim();
  if (partOf !== "") {
    failures.push(`PartOf must be empty (got '${partOf}')`);
  }

  const bindsTo = (props.BindsTo ?? "").trim();
  if (bindsTo !== "") {
    failures.push(`BindsTo must be empty (got '${bindsTo}')`);
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Detect the daemon's own systemd unit name by scanning /proc/self/cgroup
 * output. Returns null if not running under a systemd `.service` unit.
 *
 * Excludes `user@<uid>.service` (the systemd user-manager ancestor) — that's
 * the parent slice, not the daemon's own unit. The daemon's own unit is the
 * last `.service` token in the cgroup path that is NOT a user-manager unit.
 *
 * Handles both cgroup v2 (`0::/user.slice/.../X.service`) and cgroup v1
 * (`<id>:<subsystem>:/.../X.service`) — the regex extracts every `*.service`
 * token regardless of the line format.
 */
export function detectSelfUnitName(cgroupText: string): string | null {
  const matches = cgroupText.match(/([^/\s]+\.service)/g);
  if (matches === null || matches.length === 0) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = matches[i];
    if (!/^user@\d+\.service$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isEnforceEnabled(): boolean {
  const v = process.env[ENFORCE_ENV_VAR];
  if (v === undefined || v === null || v === "") return false;
  return ["true", "1", "yes"].includes(v.toLowerCase());
}

/**
 * Orchestrator — runs at daemon startup. See module-level docstring for the
 * full behavioral contract.
 *
 * Returns void unconditionally. May call process.exit(1) ONLY when:
 *   - HAPI_DAEMON_ENFORCE_SYSTEMD_INVARIANTS=1/true/yes is set, AND
 *   - the daemon IS running under a systemd .service, AND
 *   - at least one of the four invariants fails.
 *
 * In every other condition (non-Linux, no cgroup, no systemctl, parse error,
 * any internal exception), this function silently returns at debug level —
 * the daemon must continue starting up.
 */
export function runSystemdInvariantsCheck(): void {
  try {
    if (process.platform !== "linux") return;

    let cgroupText: string;
    try {
      cgroupText = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      logger.debug(
        "[DAEMON RUN] systemd invariants: /proc/self/cgroup unavailable, skipping check"
      );
      return;
    }

    const unitName = detectSelfUnitName(cgroupText);
    if (unitName === null) {
      logger.debug(
        "[DAEMON RUN] systemd invariants: not running under a systemd .service, skipping check"
      );
      return;
    }

    let output: string;
    try {
      output = execFileSync(
        "systemctl",
        [
          "--user",
          "show",
          unitName,
          "--property=KillMode,PartOf,BindsTo,Wants",
        ],
        { encoding: "utf8", timeout: 5000 }
      );
    } catch {
      logger.debug(
        `[DAEMON RUN] systemd invariants: systemctl unavailable for ${unitName}, skipping check`
      );
      return;
    }

    const props = parseSystemctlShowOutput(output);
    const { ok, failures } = validateInvariants(props);

    if (ok) {
      logger.debug(`[DAEMON RUN] systemd invariants OK for ${unitName}`);
      return;
    }

    const message =
      `[DAEMON RUN] systemd invariants violated for ${unitName}. ` +
      `These invariants protect tmux/Claude sessions from being killed on ` +
      `daemon restart (see hapimatic-private#418). Failures: ${failures.join("; ")}`;

    logger.warn(message);
    logger.reportError({
      message,
      category: "systemd-invariants",
      severity: "warn",
      context: unitName,
    });

    if (isEnforceEnabled()) {
      logger.error(
        `[DAEMON RUN] ${ENFORCE_ENV_VAR}=1 set; refusing to start due to systemd invariant violation.`
      );
      process.exit(1);
    }
  } catch (error) {
    logger.debug(
      "[DAEMON RUN] systemd invariants check failed internally, skipping",
      error
    );
  }
}
