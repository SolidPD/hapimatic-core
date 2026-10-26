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
import {
  capabilityCatalogIndex,
  FEDERATION_HEALTH_DISABLED_CODE,
} from "@hapi/protocol";
import type { CatalogEntry } from "@hapi/protocol";
import type { CommandDefinition } from "./types";
import { authenticateCli, resolveCliApiToken } from "./cliAuth";
import { listCommands } from "./registry";
import { API_RESOURCE_ACTIONS } from "./api";
import {
  HAPY_MCP_OPERATOR_TOOL_NAMES,
  HAPY_MCP_TOOL_NAMES,
} from "@/claude/utils/startHappyServer";
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
    // The Claude harness can also be handed the operator tools (#4450): an
    // operator host registers them, so they are observed here too.
    {
      harness: "claude",
      tools: [...HAPY_MCP_TOOL_NAMES, ...HAPY_MCP_OPERATOR_TOOL_NAMES],
    },
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
 * #4655: the Porter exposure gate's refusal code (`PORTER_WITHHELD_CODE` in
 * `@hapi/protocol/porter`). Spelled here because the command registry loads
 * this module on every `hapi` start, and importing the Porter barrel would add
 * its schemas to that path; `capabilities.test.ts` pins the two equal.
 */
export const PROBE_PORTER_WITHHELD_CODE = "porter_withheld";

/**
 * #5212: a capability the instance has turned off on purpose, so its probe
 * answers with a refusal that is not drift. `withheld` is Configuration Porter
 * withheld by `HAPI_PORTER_EXPOSED` (#4533, #4655); `disabled` is federation
 * health monitoring that this instance does not run.
 */
export type DeliberateOffKind = "withheld" | "disabled";

/** #4655: one readonly probe response, classified for the comparator. */
export type ProbeClassification =
  | { kind: "outcome"; outcome: ProbeOutcome }
  | { kind: DeliberateOffKind };

/**
 * #5212: the refusals that mean "turned off here". A response matches only on
 * all three of domain, status and body `code`, so the same code from another
 * domain or on another status is still drift.
 */
const DELIBERATE_OFF_STATES: readonly {
  domain: string;
  status: number;
  code: string;
  kind: DeliberateOffKind;
}[] = [
  {
    domain: "porter",
    status: 404,
    code: PROBE_PORTER_WITHHELD_CODE,
    kind: "withheld",
  },
  {
    domain: "federation",
    status: 503,
    code: FEDERATION_HEALTH_DISABLED_CODE,
    kind: "disabled",
  },
];

/** #5212: why each deliberate-off kind is not a mismatch (text output). */
const DELIBERATE_OFF_LABELS: Record<DeliberateOffKind, string> = {
  withheld:
    "Configuration Porter is withheld on this instance by HAPI_PORTER_EXPOSED",
  disabled: "federation health monitoring is not enabled on this instance",
};

/**
 * #4655: classify one readonly probe response. A 2xx is an `ok` outcome; any
 * other status is a failed outcome whose rejection is the body's `code`, then
 * its `error`, then `http_<status>`. The exceptions are the deliberate-off
 * states in `DELIBERATE_OFF_STATES`: a Porter capability answering the
 * exposure gate's 404 `porter_withheld` (discovery is not exposure, #4533) is
 * reported as withheld, and a federation-health route answering 503
 * `federation_health_disabled` (#5212) as disabled — never as drift. Matching
 * on the domain keeps either code from any other domain counted as drift.
 * PURE: exported so the verb's test classifies responses without a server.
 */
export function classifyProbeResponse(
  entry: { id: string; domain: string },
  status: number,
  body: unknown
): ProbeClassification {
  if (status >= 200 && status < 300) {
    return { kind: "outcome", outcome: { id: entry.id, ok: true } };
  }
  // axios hands back a string, "", null or undefined for a non-JSON body.
  const fields =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { code?: unknown; error?: unknown })
      : undefined;
  const code = typeof fields?.code === "string" ? fields.code : undefined;
  const error = typeof fields?.error === "string" ? fields.error : undefined;
  const off = DELIBERATE_OFF_STATES.find(
    s => s.domain === entry.domain && s.status === status && s.code === code
  );
  if (off) {
    return { kind: off.kind };
  }
  return {
    kind: "outcome",
    outcome: {
      id: entry.id,
      ok: false,
      rejection: code ?? error ?? `http_${status}`,
    },
  };
}

/** #4655: one probed capability — what was advertised, and the GET's class. */
export interface ProbeResult {
  capability: AdvertisedCapability;
  classification: ProbeClassification;
}

/**
 * #4655: fold probe results into the comparator's two inputs plus the ids of
 * each deliberate-off kind. A withheld or disabled entry leaves BOTH lists,
 * because `advertisedVsActual` reads an advertised entry with no outcome as
 * advertised-but-dead. PURE: exported so the verb's test exercises the same
 * partition the probe uses.
 */
export function partitionProbeResults(results: readonly ProbeResult[]): {
  advertised: AdvertisedCapability[];
  outcomes: ProbeOutcome[];
  withheld: string[];
  disabled: string[];
} {
  const advertised: AdvertisedCapability[] = [];
  const outcomes: ProbeOutcome[] = [];
  const off: Record<DeliberateOffKind, string[]> = {
    withheld: [],
    disabled: [],
  };
  for (const { capability, classification } of results) {
    if (classification.kind !== "outcome") {
      off[classification.kind].push(capability.id);
      continue;
    }
    advertised.push(capability);
    outcomes.push(classification.outcome);
  }
  return {
    advertised,
    outcomes,
    withheld: off.withheld,
    disabled: off.disabled,
  };
}

/** #5212: the CLI token as `resolveCliApiToken` found it, for the probe. */
export interface ProbeCliToken {
  token: string;
  /** Read from settings.json rather than the `CLI_API_TOKEN` env var. */
  fromSettings: boolean;
}

/**
 * #5212: the auth a probe GET carries. An entry whose catalog `auth` is
 * `cli-token` is sent the CLI token, because those routes reject a JWT (a
 * JWT-probed `GET /cli/sessions` read as dead with 401); every other entry is
 * sent the JWT as before. `CatalogEntry.auth` is the only input — no id is
 * special-cased. The CLI token is this instance's long-lived credential, so it
 * travels under `authenticateCli`'s rule: a settings-file token goes only to
 * the loopback server the URL names, with no ambient proxy and no redirect
 * (#5136). Pass no `cliToken` for a URL outside the configured server; the
 * entry then gets the JWT, and a refusal reads as drift. PURE: exported so the
 * verb's test checks the selection without a server.
 */
export function probeRequestFor(
  entry: { auth: CatalogEntry["auth"] },
  jwt: string,
  cliToken: ProbeCliToken | undefined
): { headers: Record<string, string>; proxy?: false; maxRedirects?: 0 } {
  if (entry.auth !== "cli-token" || cliToken === undefined) {
    return { headers: authHeaders(jwt) };
  }
  const headers = authHeaders(cliToken.token);
  return cliToken.fromSettings
    ? { headers, proxy: false, maxRedirects: 0 }
    : { headers };
}

/**
 * #3749 (Sub-Issue I / R6): opt-in readonly ADVERTISED-VS-ACTUAL probe. Fetches
 * the user-scope catalog (no `sessionId` is sent), probes each `available`, readonly, PARAMETER-FREE
 * REST GET entry (a GET with no `:param` is safe to hit), and reconciles the
 * advertised availability against the live outcomes via the PURE `audit.ts`
 * `advertisedVsActual` comparator. Opt-in behind `--probe` (NOT `--deep`, which
 * D6 cut from #3744); reports mismatches and issues only readonly GETs — but on
 * an instance that exposes Configuration Porter, the first
 * `GET /api/porter/recipient/public` creates its age keypair (#5170). #4655: a
 * Porter entry answering 404 `porter_withheld` is listed as withheld, and
 * #5212: a federation-health entry answering 503 `federation_health_disabled`
 * as disabled; both are kept out of the comparator, so neither counts as a
 * mismatch. #5212: a `cli-token` entry is probed with the CLI token
 * (`probeRequestFor`), and an entry that cannot answer without a query
 * parameter carries `probe: "skip"` in its catalog metadata. Exit 0 clean /
 * 1 mismatches / 2 tool error — recorded in the PR, NOT gated in CI (V5).
 */
async function runProbeAudit(jsonMode: boolean): Promise<void> {
  let jwt: string;
  let cliToken: ProbeCliToken | undefined;
  let catalog: {
    rest?: (CatalogEntry & { available?: boolean; reason?: string })[];
  };
  try {
    jwt = await authenticateCli(2);
    // authenticateCli exits unless a token resolved, and a second resolution
    // reports the same source (cliAuth.ts reads process.env, not the singleton).
    const resolution = await resolveCliApiToken();
    cliToken =
      resolution.kind === "env" || resolution.kind === "settings"
        ? {
            token: resolution.token,
            fromSettings: resolution.kind === "settings",
          }
        : undefined;
    const resp = await axios.get(
      `${configuration.serverUrl}/api/capabilities/catalog`,
      { headers: authHeaders(jwt), timeout: 10_000 }
    );
    catalog = resp.data as typeof catalog;
  } catch (error) {
    console.error(`capabilities probe failed: ${describeError(error)}`);
    process.exit(2);
  }

  const results: ProbeResult[] = [];
  for (const e of catalog.rest ?? []) {
    if (e.probe === "skip") continue;
    if (e.riskTier !== "readonly") continue;
    if (e.invocation.kind !== "rest" || e.invocation.method !== "GET") continue;
    // A parameterized path (`:id`) cannot be probed without a real value —
    // skip rather than emit a false "advertised-but-dead" for a 404.
    if (e.invocation.path.includes(":")) continue;
    const path = e.invocation.path;
    const absolute = path.startsWith("http");
    const url = absolute
      ? path
      : `${configuration.serverUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    let classification: ProbeClassification;
    try {
      const r = await axios.get(url, {
        // The CLI token only ever goes to the configured server.
        ...probeRequestFor(e, jwt, absolute ? undefined : cliToken),
        timeout: 8_000,
        validateStatus: () => true,
      });
      classification = classifyProbeResponse(e, r.status, r.data);
    } catch (error) {
      classification = {
        kind: "outcome",
        outcome: { id: e.id, ok: false, rejection: describeError(error) },
      };
    }
    results.push({
      capability: {
        id: e.id,
        available: e.available ?? true,
        reason: e.reason,
      },
      classification,
    });
  }

  const { advertised, outcomes, withheld, disabled } =
    partitionProbeResults(results);
  const mismatches = advertisedVsActual(advertised, outcomes);
  // Every GET issued: compared, withheld or disabled.
  const probed = advertised.length + withheld.length + disabled.length;
  if (jsonMode) {
    writeStdout(
      JSON.stringify({ probed, withheld, disabled, mismatches }, null, 2)
    );
  } else {
    const lines = [`Probed ${probed} readonly GET capabilities.`];
    for (const [kind, ids] of [
      ["withheld", withheld],
      ["disabled", disabled],
    ] as const) {
      if (ids.length > 0) {
        lines.push(
          `${ids.length} ${kind} (${DELIBERATE_OFF_LABELS[kind]}; not a ` +
            `mismatch): ${ids.join(", ")}`
        );
      }
    }
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
                 user-scope catalog (parameter-free GET readonly entries).
                 Reports mismatches and issues only readonly GETs; on an
                 instance that exposes Configuration Porter, the first
                 recipient/public GET creates its age keypair. A Porter entry
                 answering 404 porter_withheld is listed as withheld, not as a
                 mismatch. NOT --deep (cut by D6).

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
