// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi selftest argv` (hapimatic-private#5348; Matt, 63-M4 a): the dispatch decision of
 * the BUILT binary, checked against the case table below.
 *
 * Each case runs this binary (`process.execPath`) again, with the case's arguments, no
 * shell (one row goes through `bash -c` the way the daemon's tmux path does), and an
 * environment built from nothing but `PATH`, a scratch `HOME` / `USERPROFILE` /
 * `HAPI_HOME` / temp directory and `HAPI_SELFTEST_ARGV_REPORT` (plus `SystemRoot` on
 * Windows, which a Windows process needs to start). In report mode the binary writes
 * the decision `runCli` is about to act on and exits 86 before anything runs.
 *
 * What this proves (R12): the dispatch decision of the binary as built — the argv shape
 * it receives, the normalizer, the marker refusal on both dispatch paths, the claude
 * argument parser — for the target the build host can run, and in CI on Linux and
 * Windows. What it does NOT prove: what `runCli` does after the decision and the
 * launcher's delivery of the prompt (unit tests cover both), what a shell turns a typed
 * line into beyond the one `bash -c` row, a binary the build host cannot run (the public
 * release cross-compiles arm64, darwin and Windows on an x64 runner), the server's
 * refusals, and filesystem extensions.
 *
 * Never run this table against a binary without the report hook: there the cases would
 * really execute. The verb runs only inside a compiled binary, so it always runs the
 * binary that contains it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isBunCompiled } from "@/projectPath";
import { shellEscape } from "@/utils/shellEscape";
import {
  SELFTEST_ARGV_REPORT_ENV,
  SELFTEST_ARGV_REPORT_EXIT,
} from "./dispatchPlan";
import type { ArgvDecision } from "./dispatchPlan";

export type ArgvExpectation =
  | { version: true }
  | ({ refused: boolean } & Partial<Omit<ArgvDecision, "refused">>);

export type ArgvCase = {
  name: string;
  argv: string[];
  expect: ArgvExpectation;
  /** Run through `bash -c` with the tmux path's escaping (Linux and macOS only). */
  viaShell?: boolean;
};

export type ArgvCaseResult = {
  status: number | null;
  stdout: string;
  report: unknown;
};

const REFUSED = { refused: true } as const;
const RESUME_ID = "0b6a4f2e-6d7a-4c1e-9f3b-2d5c8e1a7b90";

/** The Hapimatic flags that take a value (R6): each must refuse the marker as its value. */
const VALUE_FLAGS = [
  "--hapi-starting-mode",
  "--permission-mode",
  "--hapi-permission-mode",
  "--hapi-model-mode",
  "--hapi-effort",
  "--hapi-node-default-effort",
  "--hapi-raw-model",
  "--hapi-session-role",
  "--hapi-output-style",
  "--hapi-mcp-set",
  "--started-by",
];

/**
 * The cases, for the platform the binary runs on. On Windows a prompt after the marker
 * is refused (R14), and the `bash -c` row is skipped.
 */
export function ARGV_CASES(platform: NodeJS.Platform): ArgvCase[] {
  const win = platform === "win32";
  /** A claude start with a prompt after the marker: refused on Windows (R14). */
  const prompt = (
    expected: Omit<ArgvDecision, "command" | "refused">
  ): ArgvExpectation =>
    win ? REFUSED : { refused: false, command: "claude", ...expected };

  const cases: ArgvCase[] = [
    // Security rows: before #5348 each of these lost everything before the marker.
    {
      name: "a named mode before the marker is honoured",
      argv: ["--permission-mode", "plan", "--", "review"],
      expect: prompt({
        permissionMode: "plan",
        trailing: ["--", "review"],
        claudeArgs: undefined,
      }),
    },
    {
      name: "an invalid mode before the marker is refused",
      argv: ["--permission-mode", "bogus", "--", "x"],
      expect: { refused: true, command: "claude" },
    },
    {
      name: "-- --yolo is prompt text",
      argv: ["--", "--yolo"],
      expect: prompt({
        permissionMode: undefined,
        trailing: ["--", "--yolo"],
        claudeArgs: undefined,
      }),
    },
    {
      name: "-- --permission-mode=bypassPermissions is prompt text",
      argv: ["--", "--permission-mode=bypassPermissions"],
      expect: prompt({
        permissionMode: undefined,
        trailing: ["--", "--permission-mode=bypassPermissions"],
        claudeArgs: undefined,
      }),
    },
    {
      name: "-- -v is prompt text, not the version",
      argv: ["--", "-v"],
      expect: prompt({
        permissionMode: undefined,
        trailing: ["--", "-v"],
        claudeArgs: undefined,
      }),
    },
    {
      name: "more than one word after the marker is refused",
      argv: ["--", "a", "b"],
      expect: { refused: true, command: "claude" },
    },
    {
      name: "a prompt word before the marker is refused",
      argv: ["review", "--", "x"],
      expect: { refused: true, command: "claude" },
    },
    {
      name: "a prompt word after a --flag=value before the marker is refused",
      argv: ["--model=opus", "review", "--", "x"],
      expect: { refused: true, command: "claude" },
    },
    {
      name: "a --flag=value directly before the marker keeps the prompt",
      argv: ["--model=opus", "--", "x"],
      expect: prompt({
        permissionMode: undefined,
        trailing: ["--", "x"],
        claudeArgs: ["--model=opus"],
      }),
    },
    {
      name: "a remote start with a prompt is refused",
      argv: ["--hapi-starting-mode", "remote", "--", "x"],
      expect: { refused: true, command: "claude" },
    },
    ...VALUE_FLAGS.map(
      (flag): ArgvCase => ({
        name: `${flag} cannot take the marker as its value`,
        argv: [flag, "--", "--yolo"],
        expect: { refused: true, command: "claude" },
      })
    ),
    // Every command that does not take the marker refuses it.
    {
      name: "api sessions spawn with a marker is refused",
      argv: [
        "api",
        "sessions",
        "spawn",
        "--dir",
        "/nonexistent/x",
        "--permission-mode",
        "plan",
        "--",
        "y",
      ],
      expect: { refused: true, command: "api" },
    },
    {
      name: "api sessions send with a marker is refused",
      argv: ["api", "sessions", "send", "S1", "--", "msg"],
      expect: { refused: true, command: "api" },
    },
    // The extension commands resolve to codex / gemini in the binary; refused either way.
    {
      name: "codex -- --yolo is refused",
      argv: ["codex", "--", "--yolo"],
      expect: REFUSED,
    },
    {
      name: "gemini -- --yolo is refused",
      argv: ["gemini", "--", "--yolo"],
      expect: REFUSED,
    },
    {
      name: "launcher status with a marker is refused",
      argv: ["launcher", "status", "--", "x"],
      expect: { refused: true, command: "launcher" },
    },
    {
      name: "security audit with a marker is refused (before extensions)",
      argv: ["security", "audit", "--", "--fix"],
      expect: { refused: true, command: "security" },
    },
    {
      name: "api-key-helper with a marker is refused (before extensions)",
      argv: ["api-key-helper", "--", "x"],
      expect: { refused: true, command: "api-key-helper" },
    },
    {
      name: "hook-forwarder with a marker is refused (before extensions)",
      argv: ["hook-forwarder", "--port", "1", "--", "x"],
      expect: { refused: true, command: "hook-forwarder" },
    },
    {
      name: "daemon start-sync with text after a marker is refused",
      argv: ["daemon", "start-sync", "--", "x"],
      expect: { refused: true, command: "daemon" },
    },
    {
      name: "daemon start-sync with a bare marker is refused",
      argv: ["daemon", "start-sync", "--"],
      expect: { refused: true, command: "daemon" },
    },
    {
      name: "-- daemon start-sync is not the daemon",
      argv: ["--", "daemon", "start-sync"],
      expect: { refused: true, command: "claude" },
    },
    {
      name: "companion pair with a marker is refused",
      argv: ["companion", "pair", "X", "--", "y"],
      expect: { refused: true, command: "companion" },
    },
    // Controls and the rows that must keep working.
    {
      name: "companion ssh passes the command after the marker to ssh",
      argv: ["companion", "ssh", "--session", "S1", "--", "uname", "-a"],
      expect: {
        refused: false,
        command: "companion",
        commandArgs: ["ssh", "--session", "S1", "--", "uname", "-a"],
      },
    },
    {
      name: "claude --resume <id> -- keeps the resume",
      argv: ["claude", "--resume", RESUME_ID, "--"],
      expect: {
        refused: false,
        command: "claude",
        claudeArgs: ["--resume", RESUME_ID],
        trailing: undefined,
      },
    },
    {
      name: "notes.ts is a prompt",
      argv: ["notes.ts"],
      expect: {
        refused: false,
        command: "claude",
        claudeArgs: ["notes.ts"],
        trailing: undefined,
      },
    },
    {
      name: "server starts the server",
      argv: ["server"],
      expect: { refused: false, command: "server" },
    },
    {
      name: "daemon start-sync starts the daemon",
      argv: ["daemon", "start-sync"],
      expect: {
        refused: false,
        command: "daemon",
        commandArgs: ["start-sync"],
      },
    },
    {
      name: "a -v after a command goes to the command",
      argv: ["launcher", "status", "-v"],
      expect: {
        refused: false,
        command: "launcher",
        commandArgs: ["status", "-v"],
      },
    },
    {
      name: "a first-argument -v prints the version",
      argv: ["-v"],
      expect: { version: true },
    },
  ];

  if (!win) {
    cases.push({
      name: "a tmux-style escaped command line through bash -c",
      argv: [
        "--hapi-output-style",
        "My Custom Style",
        "--permission-mode",
        "plan",
        "--",
        "review this; echo $HOME",
      ],
      viaShell: true,
      expect: {
        refused: false,
        command: "claude",
        permissionMode: "plan",
        trailing: ["--", "review this; echo $HOME"],
        claudeArgs: undefined,
      },
    });
  }
  return cases;
}

/** Whether one case's run matches its expectation; the reason when it does not. */
export function judgeArgvCase(
  c: ArgvCase,
  result: ArgvCaseResult
): { ok: true } | { ok: false; why: string } {
  if ("version" in c.expect) {
    if (result.status !== 0) {
      return { ok: false, why: `exit ${result.status}, expected 0` };
    }
    if (!result.stdout.includes("hapi version")) {
      return { ok: false, why: "the version was not printed" };
    }
    if (result.report !== null) {
      return { ok: false, why: "a report was written for the version flag" };
    }
    return { ok: true };
  }
  if (result.status !== SELFTEST_ARGV_REPORT_EXIT) {
    return {
      ok: false,
      why: `exit ${result.status}, expected ${SELFTEST_ARGV_REPORT_EXIT} (report mode)`,
    };
  }
  if (result.report === null || typeof result.report !== "object") {
    return { ok: false, why: "no report was written" };
  }
  const report = result.report as Record<string, unknown>;
  for (const [key, expected] of Object.entries(c.expect)) {
    const actual = report[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return {
        ok: false,
        why: `${key} is ${JSON.stringify(actual) ?? "absent"}, expected ${JSON.stringify(expected) ?? "absent"}`,
      };
    }
  }
  return { ok: true };
}

const CASE_TIMEOUT_MS = 60_000;

function readReport(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Run every case against this binary; 0 when all match, 1 otherwise, 2 when not compiled. */
export async function runArgvSelftest(): Promise<number> {
  if (!isBunCompiled()) {
    console.error(
      "argv selftest: runs only inside a compiled hapi binary (it runs the binary itself)"
    );
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), "hapi-argv-selftest-"));
  const failures: string[] = [];
  const cases = ARGV_CASES(process.platform);
  try {
    const home = join(scratch, "home");
    const hapiHome = join(scratch, "hapi-home");
    const temp = join(scratch, "tmp");
    for (const dir of [home, hapiHome, temp]) mkdirSync(dir);
    const baseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      HAPI_HOME: hapiHome,
      TMPDIR: temp,
      TEMP: temp,
      TMP: temp,
    };
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (process.platform === "win32" && systemRoot) {
      baseEnv.SystemRoot = systemRoot;
    }
    cases.forEach((c, index) => {
      const reportPath = join(scratch, `case-${index}.json`);
      const env = { ...baseEnv, [SELFTEST_ARGV_REPORT_ENV]: reportPath };
      const run = c.viaShell
        ? spawnSync(
            "bash",
            ["-c", [process.execPath, ...c.argv].map(shellEscape).join(" ")],
            { env, encoding: "utf8", timeout: CASE_TIMEOUT_MS }
          )
        : spawnSync(process.execPath, c.argv, {
            env,
            encoding: "utf8",
            timeout: CASE_TIMEOUT_MS,
          });
      const verdict = judgeArgvCase(c, {
        status: run.status,
        stdout: run.stdout ?? "",
        report: readReport(reportPath),
      });
      if (!verdict.ok) {
        failures.push(`${c.name} (${JSON.stringify(c.argv)}): ${verdict.why}`);
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const where = `${process.platform}-${process.arch}`;
  if (failures.length === 0) {
    console.log(
      `argv selftest: dispatch decisions ok (${cases.length} cases, ${where})`
    );
    return 0;
  }
  console.error(
    `argv selftest: FAILED ${failures.length} of ${cases.length} cases (${where}):`
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  return 1;
}
