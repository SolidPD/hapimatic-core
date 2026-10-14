// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi capabilities audit [--json] [--node <id>]` — the runtime self-audit CLI
 * verb (issue #3744, Sub-Issue D / R6, Task 5 + Task 7).
 *
 * Exit codes follow the `kicad-lint` contract: `0` clean · `1` any drift (a
 * blocking finding) · `2` tool error (the server unreachable / auth failure — the
 * verb's own failure). CI and #3747's scheduled sweep consume these.
 *
 * TWO COLLECTORS, ONE ENGINE (KD-1): the CLI is the ONLY consumer that can produce
 * a four-surface report. It observes `mcp` (per-harness) + `cli` in-process from the
 * Task-1 exports, fetches the server's `rest`+`rpc` observation from
 * `GET /api/capabilities/audit?format=full`, MERGES the two, and re-runs the SAME
 * pure `audit()` engine — never a second validator (`server/`'s `audit.ts` has only
 * `@hapi/protocol` as a runtime dep, so the CLI imports it cheaply; the cli→server
 * import mirrors `commands/server.ts`). `ui` stays `unobserved` until #3752.
 *
 * `--node <id>` proxies to a remote node's `rest`+`rpc` audit (that node's CLI would
 * add its own `mcp`+`cli`; we do not observe a remote harness), reporting the peer's
 * two-surface result as-is. No `--deep` flag (R7 CUT).
 */
import axios from "axios";
import { configuration } from "@/configuration";
import { writeStdout } from "@/utils/stdout";
import { capabilityCatalogIndex } from "@hapi/protocol";
import type { CatalogEntry } from "@hapi/protocol";
import type { CommandDefinition } from "./types";
import { authenticateCli } from "./cliAuth";
import { listCommands } from "./registry";
import { API_RESOURCE_ACTIONS } from "./api";
import { HAPY_MCP_TOOL_NAMES } from "@/claude/utils/startHappyServer";
import { HAPI_STDIO_BRIDGE_TOOL_NAMES } from "@/extensions/agent-codex/codex/happyMcpStdioBridge";
// Relative (NOT `@/`) import of the server engine: `@/` aliases to `cli/src` in
// cli/tsconfig, so a server file MUST be reached by relative path (issue #3742).
import {
  audit,
  hasDrift,
  advertisedVsActual,
  type AuditReport,
  type RuntimeSurface,
  type ObservedMcpHarness,
  type ObservedCli,
  type AdvertisedCapability,
  type ProbeOutcome,
} from "../../../server/src/capabilities/audit";
import type {
  ServerAuditResult,
  ServerAuditObservation,
} from "../../../server/src/capabilities/auditCollector";
import type { LiveCatalog } from "../../../server/src/capabilities/catalogCollector";

/** Provenance: which collector supplied each surface (Task 7 — named in `--json`). */
const LOCAL_COLLECTORS = {
  rest: "server",
  rpc: "server",
  mcp: "cli",
  cli: "cli",
  ui: "unobserved",
} as const;
const REMOTE_COLLECTORS = {
  rest: "peer",
  rpc: "peer",
  mcp: "unobserved",
  cli: "unobserved",
  ui: "unobserved",
} as const;

function authHeaders(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" };
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body = error.response?.data as { error?: string } | undefined;
    return `${status ?? "network error"} — ${body?.error ?? error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The `mcp` (per-harness) + `cli` half of the runtime surface — observed in-process
 * from the Task-1 exports. Exported for the verb's test (pure, no server).
 */
export function buildLocalSurface(): {
  mcp: ObservedMcpHarness[];
  cli: ObservedCli;
} {
  const mcp: ObservedMcpHarness[] = [
    { harness: "claude", tools: [...HAPY_MCP_TOOL_NAMES] },
    { harness: "codex-bridge", tools: [...HAPI_STDIO_BRIDGE_TOOL_NAMES] },
  ];
  // `hapi claude` is the implicit default and NOT in `listCommands()` (its
  // privacy rationale) — added here as the documented special case (R2).
  const commands = [...listCommands(), "claude"];
  const apiPairs: { resource: string; action: string }[] = [];
  for (const [resource, actions] of Object.entries(API_RESOURCE_ACTIONS)) {
    if (actions.length === 0) apiPairs.push({ resource, action: "" });
    else for (const action of actions) apiPairs.push({ resource, action });
  }
  return { mcp, cli: { commands, apiPairs } };
}

/**
 * Merge the server's `rest`+`rpc` observation with the local `mcp`+`cli` surface
 * and re-run the SAME pure engine (Task 7) — a four-surface report, `ui` unobserved.
 * PURE: exported so the verb's test exercises the merge without a live server.
 */
export function mergeLocalAuditReport(
  observed: ServerAuditObservation
): AuditReport {
  const { mcp, cli } = buildLocalSurface();
  const runtimeSurface: RuntimeSurface = {
    rest: observed.restRoutes,
    rpc: observed.rpc,
    mcp,
    cli,
  };
  const liveCatalog: LiveCatalog = {
    rest: [],
    uncatalogedRest: [],
    rpc: observed.rpcCovered,
    mcp: [],
    cli: [],
    ui: [],
  };
  return audit({
    index: capabilityCatalogIndex,
    liveCatalog,
    runtimeSurface,
    surfacesObserved: ["rest", "rpc", "mcp", "cli"],
  });
}

/** Emit the report — machine JSON (`--json`) or a compact human summary. */
function emitReport(
  report: AuditReport,
  collectors: Record<string, string>,
  jsonMode: boolean
): void {
  if (jsonMode) {
    writeStdout(
      JSON.stringify(
        {
          surfacesObserved: report.surfacesObserved,
          collectors,
          coverage: report.coverage,
          forwardDrift: report.forwardDrift,
          reverseDrift: report.reverseDrift,
          schemaErrors: report.schemaErrors,
          notMountedHere: report.notMountedHere,
          rpcObserved: report.rpcObserved,
          provenance: report.provenance,
        },
        null,
        2
      )
    );
    return;
  }
  const lines: string[] = [];
  lines.push(
    `Surfaces observed: ${report.surfacesObserved.join(", ") || "(none)"}`
  );
  lines.push("Coverage by surface:");
  for (const [surface, cov] of Object.entries(report.coverage.bySurface)) {
    const rendered =
      cov.status === "measured"
        ? `${cov.cataloged}/${cov.observed} cataloged`
        : cov.status; // n/a | unknown
    lines.push(`  ${surface} (${collectors[surface] ?? "?"}): ${rendered}`);
  }
  lines.push(
    `Drift: forward=${report.forwardDrift.length} reverse=${report.reverseDrift.length} ` +
      `schema=${report.schemaErrors.length} notMountedHere=${report.notMountedHere.length}`
  );
  if (report.rpcObserved) {
    lines.push(`RPC observed: ${report.rpcObserved.sockets} socket(s)`);
  }
  writeStdout(lines.join("\n"));
}

/** Local four-surface audit: server `rest`+`rpc` merged with local `mcp`+`cli`. */
async function runLocalAudit(jsonMode: boolean): Promise<void> {
  let result: ServerAuditResult;
  try {
    const jwt = await authenticateCli(2);
    const resp = await axios.get(
      `${configuration.serverUrl}/api/capabilities/audit?format=full`,
      { headers: authHeaders(jwt), timeout: 10_000 }
    );
    result = resp.data as ServerAuditResult;
  } catch (error) {
    // Never silently report a two-surface result as complete — the server half is
    // load-bearing, so an unreachable server is a tool error (exit 2), not "clean".
    console.error(`capabilities audit failed: ${describeError(error)}`);
    process.exit(2);
  }
  const report = mergeLocalAuditReport(result.observed);
  emitReport(report, LOCAL_COLLECTORS, jsonMode);
  process.exit(hasDrift(report) ? 1 : 0);
}

/**
 * #3749 (Sub-Issue I / R6): opt-in readonly ADVERTISED-VS-ACTUAL probe. Fetches
 * the session-aware catalog, probes each `available`, readonly, PARAMETER-FREE
 * REST GET entry (a GET with no `:param` is safe to hit), and reconciles the
 * advertised availability against the live outcomes via the PURE `audit.ts`
 * `advertisedVsActual` comparator. Opt-in behind `--probe` (NOT `--deep`, which
 * D6 cut from #3744); reports mismatches and mutates NOTHING. Exit 0 clean /
 * 1 mismatches / 2 tool error — recorded in the PR, NOT gated in CI (V5).
 */
async function runProbeAudit(jsonMode: boolean): Promise<void> {
  let headers: Record<string, string>;
  let catalog: {
    rest?: (CatalogEntry & { available?: boolean; reason?: string })[];
  };
  try {
    headers = authHeaders(await authenticateCli(2));
    const resp = await axios.get(
      `${configuration.serverUrl}/api/capabilities/catalog`,
      { headers, timeout: 10_000 }
    );
    catalog = resp.data as typeof catalog;
  } catch (error) {
    console.error(`capabilities probe failed: ${describeError(error)}`);
    process.exit(2);
  }

  const advertised: AdvertisedCapability[] = [];
  const outcomes: ProbeOutcome[] = [];
  for (const e of catalog.rest ?? []) {
    if (e.probe === "skip") continue;
    if (e.riskTier !== "readonly") continue;
    if (e.invocation.kind !== "rest" || e.invocation.method !== "GET") continue;
    // A parameterized path (`:id`) cannot be probed without a real value —
    // skip rather than emit a false "advertised-but-dead" for a 404.
    if (e.invocation.path.includes(":")) continue;
    advertised.push({
      id: e.id,
      available: e.available ?? true,
      reason: e.reason,
    });
    const path = e.invocation.path;
    const url = path.startsWith("http")
      ? path
      : `${configuration.serverUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    try {
      const r = await axios.get(url, {
        headers,
        timeout: 8_000,
        validateStatus: () => true,
      });
      if (r.status >= 200 && r.status < 300) {
        outcomes.push({ id: e.id, ok: true });
      } else {
        const body = r.data as { error?: string; code?: string } | undefined;
        outcomes.push({
          id: e.id,
          ok: false,
          rejection: body?.code ?? body?.error ?? `http_${r.status}`,
        });
      }
    } catch (error) {
      outcomes.push({ id: e.id, ok: false, rejection: describeError(error) });
    }
  }

  const mismatches = advertisedVsActual(advertised, outcomes);
  if (jsonMode) {
    writeStdout(
      JSON.stringify({ probed: advertised.length, mismatches }, null, 2)
    );
  } else {
    const lines = [`Probed ${advertised.length} readonly GET capabilities.`];
    if (mismatches.length === 0) {
      lines.push("No advertised-vs-actual mismatches.");
    } else {
      lines.push(`${mismatches.length} mismatch(es):`);
      for (const m of mismatches) {
        lines.push(`  [${m.kind}] ${m.id}: ${m.detail}`);
      }
    }
    writeStdout(lines.join("\n"));
  }
  process.exit(mismatches.length > 0 ? 1 : 0);
}

/** Remote audit: the peer's own `rest`+`rpc` report, proxied through the server. */
async function runRemoteAudit(
  nodeId: string,
  jsonMode: boolean
): Promise<void> {
  let data: {
    report?: AuditReport;
    error?: string;
    fallback?: boolean;
    peerVersion?: string | null;
  };
  try {
    const jwt = await authenticateCli(2);
    const resp = await axios.get(
      `${configuration.serverUrl}/api/capabilities/audit?nodeId=${encodeURIComponent(
        nodeId
      )}&format=full`,
      { headers: authHeaders(jwt), timeout: 10_000 }
    );
    data = resp.data;
  } catch (error) {
    console.error(
      `capabilities audit for node ${nodeId} failed: ${describeError(error)}`
    );
    process.exit(2);
  }
  if (!data.report) {
    console.error(
      `capabilities audit for node ${nodeId} failed: ${data.error ?? "no report returned"}`
    );
    process.exit(2);
  }
  if (data.fallback) {
    console.error(
      `note: node ${nodeId} runs an older binary without the audit receiver — ` +
        `showing the hub's own report (peerVersion=${data.peerVersion ?? "unknown"}).`
    );
  }
  emitReport(data.report, REMOTE_COLLECTORS, jsonMode);
  process.exit(hasDrift(data.report) ? 1 : 0);
}

function printHelp(): void {
  console.log(`
hapi capabilities audit - reconcile the committed capability index against the live runtime surface

Usage:
  hapi capabilities audit [--json] [--node <id>] [--probe]

Options:
  --json         Machine-readable report (validates against the documented schema)
  --node <id>    Audit a remote federation node's rest+rpc surface (proxied)
  --probe        #3749: opt-in readonly advertised-vs-actual probe of the
                 session-aware catalog (parameter-free GET readonly entries).
                 Reports mismatches; mutates nothing. NOT --deep (cut by D6).

Exit codes:
  0  clean (no drift / no mismatches)
  1  drift present (forward / reverse / schema) OR probe mismatches
  2  tool error (server unreachable, auth failure)
`);
}

export const capabilitiesCommand: CommandDefinition = {
  name: "capabilities",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const action = commandArgs[0];
    if (action !== "audit") {
      printHelp();
      // A missing/unknown subcommand is a usage (tool) error.
      process.exit(action === undefined || action === "help" ? 0 : 2);
    }
    const rest = commandArgs.slice(1);
    const jsonMode = rest.includes("--json");
    const probeMode = rest.includes("--probe");
    const nodeIdx = rest.indexOf("--node");
    const nodeId =
      nodeIdx !== -1 && nodeIdx + 1 < rest.length
        ? rest[nodeIdx + 1]
        : undefined;
    if (probeMode) {
      // #3749 (R6): opt-in advertised-vs-actual readonly probe (NOT --deep, D6).
      await runProbeAudit(jsonMode);
    } else if (nodeId) {
      await runRemoteAudit(nodeId, jsonMode);
    } else {
      await runLocalAudit(jsonMode);
    }
  },
};
