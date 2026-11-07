// SPDX-License-Identifier: AGPL-3.0-only
/**
 * bench-transcript-tail v1 — issue #6264. Operator tool; NOT run in CI.
 *
 * Measures the bounded transcript readers against the old whole-file reads, and
 * checks tail/full equivalence over real transcripts.
 *
 * Size table:
 *   bun scripts/bench-transcript-tail-v1.ts --source <real.jsonl> \
 *     [--sizes 10,100,250,520] [--old-max 250] [--last-turn-mib 1] [--out /tmp/bench-6264] [--keep]
 *
 *   Builds a synthetic transcript of each size by repeating --source, rewriting
 *   every copy's `uuid` / `parentUuid` so the reader's dedup cannot collapse it,
 *   streamed to disk (the builder never holds the file in memory). Each
 *   measurement then runs in its own child process, so one row's heap never
 *   inflates the next row's RSS. The old full path is skipped above --old-max
 *   MiB ("not run (memory)"): a 520 MiB whole-file parse needs several GB.
 *
 * Equivalence:
 *   bun scripts/bench-transcript-tail-v1.ts --eq <dir> [--eq-max-mib 64]
 *
 *   For every main transcript under <dir> (sub-agent files excluded), compares
 *   `parseTurn` and `lastMessageTsMs` on the tail path (`fullReadMaxBytes: 0`)
 *   with the full path, on a snapshot copy so a live session's appends between
 *   the two reads cannot show up as a mismatch. Files above --eq-max-mib are listed but not compared,
 *   because the full side is the very read #6264 removed from the server.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  classifyAgentLaunch,
  lastMessageTsMs,
  parseTurn,
  type TurnParseResult,
} from "../src/sync/transcript/transcriptParser";
import { findNeedlesInFile } from "../src/sync/transcript/transcriptReader";

const VERSION = "bench-transcript-tail v1";
const MIB = 1024 * 1024;

type Reader =
  | "parseTurn"
  | "lastMessageTsMs"
  | "classifyAgentLaunch"
  | "pmTokenScan";
const READERS: Reader[] = [
  "parseTurn",
  "lastMessageTsMs",
  "classifyAgentLaunch",
  "pmTokenScan",
];

interface Measurement {
  ms: number;
  rssDeltaMb: number;
  peakRssMb: string | null;
  ok: string;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

// ───────────────────────────── child: one measurement ─────────────────────────────

function measure(
  path: string,
  reader: Reader,
  mode: "new" | "old"
): Measurement {
  const ccSessionId = basename(path).replace(/\.jsonl$/, "");
  const full =
    mode === "old" ? { fullReadMaxBytes: Number.POSITIVE_INFINITY } : {};
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  const peak0 = maxRssBytes();
  const t0 = performance.now();
  let ok: string;
  switch (reader) {
    case "parseTurn": {
      const r = parseTurn({ transcriptPath: path, ccSessionId, ...full });
      ok = r.parseError ?? (r.promptMsgUuid ? "turn" : "no-turn");
      break;
    }
    case "lastMessageTsMs": {
      const r = lastMessageTsMs({ transcriptPath: path, ...full });
      ok = r === null ? "null" : "ts";
      break;
    }
    case "classifyAgentLaunch": {
      // An id that is not in the file: the worst case, a scan to the cap.
      ok = classifyAgentLaunch(path, "toolu_absent_6264_bench", full);
      break;
    }
    case "pmTokenScan": {
      // pmReconcileStep's whole-file scan with a token that is not there.
      const needle = Buffer.from(
        "PM-COMPLETION-TOKEN: PMDONE-absent6264bench0000"
      );
      if (mode === "old") {
        ok = readFileSync(path, "utf-8").includes(needle.toString())
          ? "hit"
          : "miss";
      } else {
        ok = findNeedlesInFile(path, [needle]).size > 0 ? "hit" : "miss";
      }
      break;
    }
  }
  const ms = performance.now() - t0;
  const rss1 = process.memoryUsage().rss;
  const peak1 = maxRssBytes();
  // VmHWM is a high-water mark since exec. Only a call that raised it has a
  // measurable peak; otherwise its peak stayed under the module-load peak.
  const peakRssMb =
    peak0 === null || peak1 === null
      ? null
      : peak1 > peak0
        ? `${Math.round((peak1 - rss0) / MIB)}`
        : `≤${Math.round((peak0 - rss0) / MIB)}`;
  return {
    ms: Math.round(ms),
    rssDeltaMb: Math.round((rss1 - rss0) / MIB),
    peakRssMb,
    ok,
  };
}

/**
 * This address space's peak RSS (`VmHWM`). Not `process.resourceUsage().maxRSS`:
 * on Linux `ru_maxrss` survives `execve`, so a child would report the builder
 * parent's peak. `VmHWM` belongs to the new address space and starts at exec.
 */
function maxRssBytes(): number | null {
  try {
    const m = /^VmHWM:\s+(\d+) kB$/m.exec(
      readFileSync("/proc/self/status", "utf8")
    );
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── builder ─────────────────────────────

function isMainChainPromptLine(line: string): boolean {
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    const content = (r.message as { content?: unknown } | undefined)?.content;
    const soleToolResult =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        b => (b as { type?: unknown } | null)?.type === "tool_result"
      );
    return (
      r.type === "user" &&
      !r.isSidechain &&
      !r.isMeta &&
      !r.isCompactSummary &&
      !r.isVisibleInTranscriptOnly &&
      !soleToolResult
    );
  } catch {
    return false;
  }
}

function isMainChainAssistantLine(line: string): boolean {
  try {
    const r = JSON.parse(line) as Record<string, unknown>;
    return r.type === "assistant" && !r.isSidechain;
  } catch {
    return false;
  }
}

/**
 * A synthetic transcript of `mib` MiB: the source repeated (each copy's uuids
 * rewritten), then a complete final turn of about `lastTurnMib` MiB — one
 * main-chain prompt and main-chain assistant lines from the source. Without the
 * final turn, the cut at the target size can land inside one of the source's
 * long turns, and `parseTurn` would measure its fail-open instead of a turn.
 */
function buildSynthetic(
  source: string,
  mib: number,
  lastTurnMib: number,
  outDir: string
): string {
  const lines = readFileSync(source, "utf-8")
    .split("\n")
    .filter(l => l.trim() !== "");
  const promptLine = lines.find(isMainChainPromptLine);
  const assistantLines = lines.filter(isMainChainAssistantLine);
  if (promptLine === undefined || assistantLines.length === 0) {
    throw new Error("source has no main-chain prompt or assistant line");
  }
  const ccid = `00000000-0000-4000-8000-${String(mib).padStart(12, "0")}`;
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${ccid}.jsonl`);
  const fd = openSync(out, "w");
  const lastTurnBytes = Math.floor(lastTurnMib * MIB);
  const bodyTarget = Math.max(0, mib * MIB - lastTurnBytes);
  let batch: string[] = [];
  let batchBytes = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    writeSync(fd, batch.join(""));
    batch = [];
    batchBytes = 0;
  };
  const push = (line: string, suffix: string): number => {
    const s =
      line.replace(
        /"(uuid|parentUuid)":"([0-9a-f-]{36})"/g,
        (_m, key: string, u: string) => `"${key}":"${u.slice(0, 24)}${suffix}"`
      ) + "\n";
    const n = Buffer.byteLength(s);
    batch.push(s);
    batchBytes += n;
    if (batchBytes >= 8 * MIB) flush();
    return n;
  };
  try {
    let bytes = 0;
    for (let copy = 0; bytes < bodyTarget; copy += 1) {
      const suffix = String(copy).padStart(12, "0");
      for (const line of lines) {
        bytes += push(line, suffix);
        if (bytes >= bodyTarget) break;
      }
    }
    // The final turn. Distinct suffixes keep every line past the uuid dedup.
    let turnBytes = push(promptLine, "ffffffffffff");
    for (let i = 0; turnBytes < lastTurnBytes; i += 1) {
      const line = assistantLines[i % assistantLines.length];
      turnBytes += push(line, `f${String(i).padStart(11, "0")}`);
    }
    flush();
  } finally {
    closeSync(fd);
  }
  return out;
}

// ───────────────────────────── equivalence ─────────────────────────────

function listTranscripts(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name !== "subagents") listTranscripts(p, out);
    } else if (name.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

/** `skipped` counts the window on the tail path, so it legitimately differs. */
function comparable(r: TurnParseResult): string {
  const rest: Partial<TurnParseResult> = { ...r };
  delete rest.skipped;
  return JSON.stringify(rest);
}

function runEquivalence(dir: string, maxMib: number): void {
  const files = listTranscripts(dir);
  let compared = 0;
  let parseMismatch = 0;
  let watermarkMismatch = 0;
  let fullNull = 0;
  const tooBig: string[] = [];
  // Compare on a snapshot: a live session appends to its transcript between the
  // two reads, which would show up as a mismatch that is not one.
  const snapRoot = mkdtempSync(join(tmpdir(), "bench-6264-eq-"));
  try {
    for (const f of files) {
      const size = statSync(f).size;
      if (size > maxMib * MIB) {
        tooBig.push(`${f} (${(size / MIB).toFixed(1)} MiB)`);
        continue;
      }
      compared += 1;
      const ccSessionId = basename(f).replace(/\.jsonl$/, "");
      const snapDir = mkdtempSync(join(snapRoot, "f-"));
      const snap = join(snapDir, basename(f));
      copyFileSync(f, snap);
      // parseTurn finds sub-agent files in the `<ccSessionId>/` sibling dir.
      const siblings = join(dirname(f), ccSessionId);
      if (existsSync(siblings))
        symlinkSync(siblings, join(snapDir, ccSessionId));

      const full = parseTurn({ transcriptPath: snap, ccSessionId });
      const tail = parseTurn({
        transcriptPath: snap,
        ccSessionId,
        fullReadMaxBytes: 0,
      });
      if (full.parseError !== null || full.promptMsgUuid === null) {
        fullNull += 1;
      }
      // transcriptPath is the snapshot on both sides, so it compares equal.
      if (comparable(full) !== comparable(tail)) {
        parseMismatch += 1;
        console.log(`parseTurn MISMATCH ${f}`);
      }
      const wFull = lastMessageTsMs({ transcriptPath: snap });
      const wTail = lastMessageTsMs({
        transcriptPath: snap,
        fullReadMaxBytes: 0,
      });
      if (wFull !== wTail) {
        watermarkMismatch += 1;
        console.log(
          `lastMessageTsMs MISMATCH ${f}: full=${wFull} tail=${wTail}`
        );
      }
      rmSync(snapDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(snapRoot, { recursive: true, force: true });
  }
  console.log(
    JSON.stringify({
      version: VERSION,
      transcripts: files.length,
      compared,
      parseTurnMismatches: parseMismatch,
      lastMessageTsMsMismatches: watermarkMismatch,
      fullParseNullOrError: fullNull,
      notComparedOverMaxMib: tooBig.length,
    })
  );
  for (const t of tooBig) console.log(`not compared (over --eq-max-mib): ${t}`);
}

// ───────────────────────────── main ─────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args[0] === "--measure") {
    const [, path, reader, mode] = args;
    console.log(
      JSON.stringify(measure(path, reader as Reader, mode as "new" | "old"))
    );
    return;
  }

  console.log(VERSION);

  const eqDir = argValue(args, "--eq");
  if (eqDir !== undefined) {
    runEquivalence(eqDir, Number(argValue(args, "--eq-max-mib") ?? 64));
    return;
  }

  const source = argValue(args, "--source");
  if (source === undefined) {
    console.error(
      "usage: --source <real.jsonl> [--sizes 10,100,250,520] | --eq <dir>"
    );
    process.exit(2);
  }
  const sizes = (argValue(args, "--sizes") ?? "10,100,250,520")
    .split(",")
    .map(Number);
  const oldMax = Number(argValue(args, "--old-max") ?? 250);
  const outDir = argValue(args, "--out") ?? "/tmp/bench-6264";
  const keep = args.includes("--keep");
  const lastTurnMib = Number(argValue(args, "--last-turn-mib") ?? 1);

  const rows: string[] = [
    "| Size (MiB) | Path | Reader | ms | RSS Δ after (MB) | Peak RSS Δ (MB) | Result |",
    "|---:|---|---|---:|---:|---:|---|",
  ];
  for (const mib of sizes) {
    const path = buildSynthetic(source, mib, lastTurnMib, outDir);
    for (const mode of ["new", "old"] as const) {
      for (const reader of READERS) {
        if (mode === "old" && mib > oldMax) {
          rows.push(
            `| ${mib} | old (full) | ${reader} | — | — | — | not run (memory) |`
          );
          continue;
        }
        const r = Bun.spawnSync([
          process.execPath,
          import.meta.path,
          "--measure",
          path,
          reader,
          mode,
        ]);
        const text = r.stdout.toString().trim();
        if (r.exitCode !== 0 || text === "") {
          rows.push(
            `| ${mib} | ${mode === "new" ? "new (bounded)" : "old (full)"} | ${reader} | — | — | — | child failed (exit ${r.exitCode}) |`
          );
          continue;
        }
        const m = JSON.parse(text) as Measurement;
        rows.push(
          `| ${mib} | ${mode === "new" ? "new (bounded)" : "old (full)"} | ${reader} | ${m.ms} | ${m.rssDeltaMb} | ${m.peakRssMb ?? "?"} | ${m.ok} |`
        );
      }
    }
    if (!keep) rmSync(path, { force: true });
  }
  console.log(rows.join("\n"));
}

main();
