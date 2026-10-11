// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";

import type { ErrorLogger } from "../logging/errorLogger";

/**
 * OS-cron read-only discovery (issue #1964, Sub-Issue D — PR3).
 *
 * Surfaces the host user's `crontab -l` entries as read-only System Jobs rows so
 * the portal is a true single pane of glass for background jobs. Unlike the
 * declarative systemd timers (#1534) and the observed in-process loops (#1963),
 * OS crons are neither managed nor stall-detected here — they are plain
 * discovery (no enable/disable, no alerting). Best-effort: a host with no
 * crontab (`crontab -l` exits non-zero) or no `crontab` binary yields `[]`.
 */

/** One discovered crontab entry. No node field — grouped under the reading node. */
export interface OsCronRow {
  /** The schedule expression: a 5-field cron spec or an `@`-keyword (`@daily`). */
  schedule: string;
  /** The command to run (with any `# LOOP-CRON:<id>` marker stripped for display). */
  command: string;
  /** The raw crontab line (for display / debugging). */
  line: string;
  /**
   * The loop-cron id when this row is a `loop-cron.sh` job (issue #2453).
   * `loop-cron.sh` installs its lines with a TRAILING marker comment
   * (`… tick <id> # LOOP-CRON:<id>`, script `:863`), so the marker survives into
   * the parsed `command`. Present only on loop-cron rows.
   */
  loopCronId?: string;
}

/**
 * Extract the trailing `# LOOP-CRON:<id>` marker from a parsed cron command
 * (issue #2453). The marker is appended to the job line by `loop-cron.sh:863`
 * (`local line="${cron_expr} ${SELF} tick ${id} # LOOP-CRON:${id}"`), so it lands
 * at the END of `command`. Returns the command with the marker removed for
 * display plus the extracted id (or `undefined` for an ordinary cron line).
 */
function extractLoopCronMarker(command: string): {
  command: string;
  loopCronId?: string;
} {
  const m = command.match(/\s*#\s*LOOP-CRON:(\S+)\s*$/);
  if (!m) return { command };
  return { command: command.slice(0, m.index).trimEnd(), loopCronId: m[1] };
}

/**
 * Parse `crontab -l` output into rows. Skips blank lines, `#` comments, and
 * `NAME=value` environment assignments. Handles both 5-field specs
 * (`m h dom mon dow command`) and `@`-keywords (`@reboot command`).
 */
export function parseCrontab(output: string): OsCronRow[] {
  const rows: OsCronRow[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Environment assignment (e.g. PATH=/usr/bin, SHELL=/bin/sh) — not a job.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
    if (line.startsWith("@")) {
      const m = line.match(/^(@\S+)\s+(.+)$/);
      if (m) {
        const { command, loopCronId } = extractLoopCronMarker(m[2]);
        rows.push({ schedule: m[1], command, line, loopCronId });
      }
      continue;
    }
    // 5 whitespace-separated schedule fields, then the command (which may
    // itself contain whitespace).
    const m = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
    if (m) {
      const { command, loopCronId } = extractLoopCronMarker(m[2]);
      rows.push({
        schedule: m[1].replace(/\s+/g, " "),
        command,
        line,
        loopCronId,
      });
    }
  }
  return rows;
}

/** The real host-crontab runner. The server wires this into SystemJobsService;
 *  it is deliberately NOT a SystemJobsService default, so tests stay hermetic
 *  (os-cron is opt-in — only read when a runCrontab is provided). */
export function readHostCrontab(): string {
  return execFileSync("crontab", ["-l"], { encoding: "utf8" });
}

export interface OsCronReaderDeps {
  errorLogger?: ErrorLogger | null;
  /** Test seam — returns raw `crontab -l` output (or throws like a missing crontab). */
  runCrontab?: () => string;
}

/** Reads + parses the host crontab. Best-effort; never throws. */
export class OsCronReader {
  constructor(private readonly deps: OsCronReaderDeps = {}) {}

  read(): OsCronRow[] {
    let out: string;
    try {
      out = (this.deps.runCrontab ?? readHostCrontab)();
    } catch {
      // `crontab -l` exits 1 with "no crontab for <user>", or the binary is
      // absent — both mean "no OS crons to show". Never breaks the portal.
      return [];
    }
    return parseCrontab(out);
  }
}
