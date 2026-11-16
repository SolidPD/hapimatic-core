// SPDX-License-Identifier: AGPL-3.0-only
/**
 * TEST-ONLY stand-in for the `claude` executable (issue #6627). Nothing in the
 * product imports it; the child-lifetime tests do.
 *
 * `writeStandInClaude(dir, script)` writes an executable Node script named
 * `claude` into `dir`, plus the per-run `script.json` it follows. A test points
 * `HAPI_CLAUDE_PATH` at the returned path and uses `dir` as the session's
 * working directory, so the real `query()` spawns the stand-in with `dir` as its
 * cwd. The script never reads its behaviour from the environment, because the
 * launcher rebuilds the child's environment.
 *
 * The stand-in, per process:
 * - appends its pid to `<cwd>/pids`; its ordinal there picks its entry in
 *   `script.children` (a relaunched child gets the next entry);
 * - writes its argv to `<cwd>/argv-<pid>` (JSON);
 * - records every stdin line (first 200 chars) in `<cwd>/received-<pid>`;
 * - answers every control request the wrapper sends with an error, so a
 *   get_context_usage or get_settings call settles at once;
 * - on the n-th user line plays `turns[n]` (past the end: "normal");
 * - when its script has a `wakeAfterMs`, arms its own timer at the end of each
 *   turn's output that writes `<cwd>/woke-<pid>` (the ms1 wake: a process that
 *   nobody reads still acts on its own schedule);
 * - exits 0 when its stdin ends, as Claude Code does, unless told otherwise.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./utils/path";

/**
 * - `normal`: an assistant text, then one result (`duration_api_ms: 50`, "ok").
 * - `bounce`: three results with `duration_api_ms: 0` and an empty `result`.
 * - `deny` / `plan`: an assistant `tool_use` (id `t1`; `Bash`, or
 *   `ExitPlanMode`), then a `can_use_tool` control request for it; once the
 *   wrapper answers, a `user` `tool_result` for `t1`, and nothing more.
 * - `silent`: no output (a turn still in progress).
 * - `{ exitCode }`: exit with that code at once.
 */
export type StandInTurn =
  | "normal"
  | "bounce"
  | "deny"
  | "plan"
  | "silent"
  | { exitCode: number };

export interface StandInChildScript {
  turns?: StandInTurn[];
  /** Sent on `system/init` at each turn start and on every result. */
  sessionId?: string;
  /** Arm a wake this long after each turn's output; it writes `woke-<pid>`. */
  wakeAfterMs?: number;
  /** Install a SIGTERM handler that does nothing (for the SIGKILL step). */
  ignoreSigterm?: boolean;
  /** Keep running after stdin ends. */
  ignoreStdinEnd?: boolean;
  /** Exit this long after stdin ends instead of at once. */
  lingerOnStdinEndMs?: number;
  /** Leave the wrapper's control requests unanswered. */
  ignoreControlRequests?: boolean;
  /** Space a bounce's three empty results this far apart (default: at once). */
  bounceGapMs?: number;
}

export interface StandInScript {
  /** Entry i scripts the i-th child started in this directory. */
  children: StandInChildScript[];
}

const STAND_IN_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const cwd = process.cwd();
const pid = process.pid;
const pidsFile = path.join(cwd, "pids");
const ordinal = fs.existsSync(pidsFile)
  ? fs.readFileSync(pidsFile, "utf8").split("\\n").filter(Boolean).length
  : 0;
fs.appendFileSync(pidsFile, pid + "\\n");
fs.writeFileSync(path.join(cwd, "argv-" + pid), JSON.stringify(process.argv.slice(2)));
const script = JSON.parse(fs.readFileSync(path.join(cwd, "script.json"), "utf8"));
const me = (script.children && script.children[ordinal]) || {};
const turns = me.turns || [];

if (me.ignoreSigterm) process.on("SIGTERM", function () {});
if (me.ignoreStdinEnd) setInterval(function () {}, 1 << 30);

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

let wakeTimer = null;
function armWake() {
  if (!me.wakeAfterMs) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(function () {
    fs.writeFileSync(path.join(cwd, "woke-" + pid), String(Date.now()));
  }, me.wakeAfterMs);
}

let userLines = 0;
const pendingAnswers = new Map();

function init() {
  if (!me.sessionId) return;
  emit({ type: "system", subtype: "init", session_id: me.sessionId, model: "stand-in",
    cwd: cwd, tools: [], mcp_servers: [], permissionMode: "default", apiKeySource: "none" });
}

function result(apiMs, text) {
  emit({ type: "result", subtype: "success", duration_ms: apiMs + 10, duration_api_ms: apiMs,
    num_turns: userLines, is_error: false, result: text, total_cost_usd: 0, session_id: me.sessionId });
}

function askThenToolResult(toolName, input) {
  emit({ type: "assistant", session_id: me.sessionId,
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: toolName, input: input }] } });
  const requestId = "stand-in-" + pid + "-" + userLines;
  pendingAnswers.set(requestId, function (answer) {
    emit({ type: "user", session_id: me.sessionId, message: { role: "user", content: [{
      type: "tool_result", tool_use_id: "t1", is_error: true,
      content: (answer && answer.message) || "answered" }] } });
    armWake();
  });
  emit({ type: "control_request", request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: toolName, input: input } });
}

function runTurn(turn) {
  if (turn && typeof turn === "object" && typeof turn.exitCode === "number") {
    process.exit(turn.exitCode);
  }
  init();
  if (turn === "bounce") {
    const gap = me.bounceGapMs || 0;
    [0, 1, 2].forEach(function (i) {
      setTimeout(function () {
        result(0, "");
        if (i === 2) armWake();
      }, gap * i);
    });
    return;
  }
  if (turn === "deny") {
    askThenToolResult("Bash", { command: "echo stand-in" });
    return;
  }
  if (turn === "plan") {
    askThenToolResult("ExitPlanMode", { plan: "stand-in plan" });
    return;
  }
  if (turn === "silent") {
    armWake();
    return;
  }
  emit({ type: "assistant", session_id: me.sessionId,
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  result(50, "ok");
  armWake();
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", function (line) {
  fs.appendFileSync(path.join(cwd, "received-" + pid), line.slice(0, 200) + "\\n");
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }
  if (msg.type === "control_response") {
    const id = msg.response && msg.response.request_id;
    const answer = pendingAnswers.get(id);
    if (answer) {
      pendingAnswers.delete(id);
      answer(msg.response.response);
    }
    return;
  }
  if (msg.type === "control_request") {
    if (me.ignoreControlRequests) return;
    emit({ type: "control_response",
      response: { subtype: "error", request_id: msg.request_id, error: "not supported by the stand-in" } });
    return;
  }
  if (msg.type === "user") {
    const turn = turns[userLines] || "normal";
    userLines += 1;
    runTurn(turn);
  }
});
rl.on("close", function () {
  if (me.ignoreStdinEnd) return;
  if (me.lingerOnStdinEndMs) {
    setTimeout(function () { process.exit(0); }, me.lingerOnStdinEndMs);
    return;
  }
  process.exit(0);
});
`;

/** Writes the stand-in (`<dir>/claude`, mode 0755) and its `script.json`; returns its path. */
export function writeStandInClaude(dir: string, script: StandInScript): string {
  const executable = join(dir, "claude");
  writeFileSync(executable, STAND_IN_SOURCE);
  chmodSync(executable, 0o755);
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  return executable;
}

/** Pre-creates the session's transcript, so the wait for it returns at once. */
export function prepareTranscript(
  configDir: string,
  cwd: string,
  sessionId: string
): void {
  const projectDir = getProjectPath(cwd, configDir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({ uuid: "stand-in-1", type: "user" })}\n`
  );
}

/** Every pid a stand-in started in `dir` wrote, oldest first. */
export function readStandInPids(dir: string): number[] {
  const file = join(dir, "pids");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => Number(line));
}

/** The stdin lines the stand-in with this pid received (first 200 chars each). */
export function readReceived(dir: string, pid: number): string[] {
  const file = join(dir, `received-${pid}`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean);
}

/** The argv the stand-in with this pid was started with. */
export function readArgv(dir: string, pid: number): string[] {
  return JSON.parse(readFileSync(join(dir, `argv-${pid}`), "utf8")) as string[];
}

/** True when the stand-in with this pid has fired its own wake. */
export function hasWoken(dir: string, pid: number): boolean {
  return existsSync(join(dir, `woke-${pid}`));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The stand-ins started in `dir` that are alive now. */
export function aliveStandIns(dir: string): number[] {
  return readStandInPids(dir).filter(isAlive);
}

/** SIGKILLs every stand-in started in `dir` that is still alive (for afterEach). */
export function killAll(dir: string): void {
  for (const pid of aliveStandIns(dir)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone between the check and the kill.
    }
  }
}

/**
 * Samples how many stand-ins are alive every `intervalMs` until `stop()`,
 * which returns the largest count seen (and samples once more).
 */
export function sampleAliveStandIns(
  dir: string,
  intervalMs: number = 20
): { stop(): number } {
  let max = aliveStandIns(dir).length;
  const timer = setInterval(() => {
    max = Math.max(max, aliveStandIns(dir).length);
  }, intervalMs);
  return {
    stop(): number {
      clearInterval(timer);
      max = Math.max(max, aliveStandIns(dir).length);
      return max;
    },
  };
}
