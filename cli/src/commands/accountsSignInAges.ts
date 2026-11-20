// SPDX-License-Identifier: AGPL-3.0-only
import {
  isSignInDeath,
  listSignInAges,
  parseNodeAccountHealthPerEntry,
  wholeSignInDays,
  type NodeAccountHealth,
  type SignInAge,
  type SignInAgeCoverage,
  type SignInAgeList,
  type SignInAgeRow,
  type SignInDeathRow,
} from "@hapi/protocol";
import { authenticateCli } from "@/commands/cliAuth";
import { configuration } from "@/configuration";
import { writeStdout } from "@/utils/stdout";

/**
 * `hapi accounts sign-in-ages [--dead] [--json]` (issue #6801, R10): the one
 * cross-node list of how long each Anthropic `oauth` login has lived on each
 * node, and when a dead one stopped refreshing. READ-ONLY: it reads the hub's
 * per-node account-health aggregate (`GET /api/federation/account-health`) and
 * runs the shared `listSignInAges` over it. Nodes it could not read in full are
 * listed under coverage, never silently dropped.
 */

export interface SignInAgesFlags {
  json: boolean;
  dead: boolean;
}

export function parseSignInAgesFlags(args: string[]): SignInAgesFlags {
  return {
    json: args.includes("--json") || args.includes("-j"),
    dead: args.includes("--dead"),
  };
}

/** `--dead`: dead rows and past deaths only; coverage always stays. */
export function filterSignInAges(
  list: SignInAgeList,
  dead: boolean
): SignInAgeList {
  return dead
    ? { ...list, rows: list.rows.filter(r => isSignInDeath(r.age.state)) }
    : list;
}

/** The AGE cell for one row. */
export function formatAgeCell(row: SignInAgeRow): string {
  const { age } = row;
  switch (age.state) {
    case "running":
      return `${age.days} d`;
    case "stopped":
      return `died at ${age.days} d (alive at ${wholeSignInDays(age.signedInAt, row.lastAliveAt)} d)`;
    case "stopped-unknown":
      return "died, time not recorded";
    case "quarantined":
      return `${age.days} d, quarantined (login shared with ~/.claude)`;
    case "flagged-unreported":
      return "flagged; this node's build does not report deaths";
  }
}

/** One coverage line: why a node was not read in full. */
export function formatCoverageLine(c: SignInAgeCoverage): string {
  const parts: string[] = [c.status];
  if (c.reason) parts[0] = `${c.status} (${c.reason})`;
  if (c.rejectedEntries !== undefined) {
    parts.push(`${c.rejectedEntries} record(s) not readable`);
  }
  if (c.deathsNotReported) parts.push("older build: deaths not reported");
  return `${c.nodeLabel}: ${parts.join(", ")}`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0))
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

/**
 * The human table: `NODE  ACCOUNT  AGE  STATE`, then "Past deaths", then every
 * coverage node on its own line. Days only, never an absolute time, so no time
 * zone applies.
 */
export function formatSignInAgesTable(
  list: SignInAgeList,
  opts: { dead: boolean }
): string {
  const shown = filterSignInAges(list, opts.dead);
  const out: string[] = [];
  if (shown.rows.length === 0) {
    out.push(opts.dead ? "No dead sign-ins." : "No Anthropic OAuth sign-ins.");
  } else {
    out.push(
      ...table(
        ["NODE", "ACCOUNT", "AGE", "STATE"],
        shown.rows.map(r => [
          r.nodeLabel,
          r.emailAddress,
          formatAgeCell(r),
          r.age.state,
        ])
      )
    );
  }
  if (shown.past.length > 0) {
    out.push("", "Past deaths");
    out.push(
      ...table(
        ["NODE", "ACCOUNT", "AGE"],
        shown.past.map(p => [
          p.nodeLabel,
          p.emailAddress,
          `died at ${p.days} d (alive at ${wholeSignInDays(p.signedInAt, p.lastAliveAt)} d)`,
        ])
      )
    );
  }
  if (shown.coverage.length > 0) {
    out.push("", "Not read in full");
    out.push(...shown.coverage.map(c => `  ${formatCoverageLine(c)}`));
  }
  return out.join("\n");
}

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

export type JsonAgeRow = {
  nodeId: string;
  nodeLabel: string;
  accountUuid: string;
  emailAddress: string;
  state: SignInAge["state"];
  days: number | null;
  signedInAt: number;
  signedInAtIso: string | null;
  diedAt: number | null;
  diedAtIso: string | null;
  lastAliveAt: number;
  lastAliveAtIso: string | null;
};

function jsonRow(row: SignInAgeRow): JsonAgeRow {
  const { age } = row;
  const days =
    age.state === "running" ||
    age.state === "stopped" ||
    age.state === "quarantined"
      ? age.days
      : null;
  const diedAt = age.state === "stopped" ? age.diedAt : null;
  return {
    nodeId: row.nodeId,
    nodeLabel: row.nodeLabel,
    accountUuid: row.accountUuid,
    emailAddress: row.emailAddress,
    state: age.state,
    days,
    signedInAt: age.signedInAt,
    signedInAtIso: iso(age.signedInAt),
    diedAt,
    diedAtIso: iso(diedAt),
    lastAliveAt: row.lastAliveAt,
    lastAliveAtIso: iso(row.lastAliveAt),
  };
}

function jsonPast(p: SignInDeathRow): JsonAgeRow {
  return {
    nodeId: p.nodeId,
    nodeLabel: p.nodeLabel,
    accountUuid: p.accountUuid,
    emailAddress: p.emailAddress,
    state: "stopped",
    days: p.days,
    signedInAt: p.signedInAt,
    signedInAtIso: iso(p.signedInAt),
    diedAt: p.diedAt,
    diedAtIso: iso(p.diedAt),
    lastAliveAt: p.lastAliveAt,
    lastAliveAtIso: iso(p.lastAliveAt),
  };
}

/**
 * The `--json` contract: `generatedAt`, `signedInAt`, `diedAt` and `lastAliveAt`
 * are epoch-ms numbers, each with an `*Iso` sibling (`null` when the number is
 * `null`). `days` and `diedAt` are `null` for `stopped-unknown` and
 * `flagged-unreported`; `diedAt` is `null` for `running` and `quarantined`.
 * `past` rows use the same keys.
 */
export type SignInAgesJson = {
  generatedAt: number;
  generatedAtIso: string | null;
  rows: JsonAgeRow[];
  past: JsonAgeRow[];
  coverage: SignInAgeCoverage[];
};

export function toSignInAgesJson(
  list: SignInAgeList,
  opts: { dead: boolean; generatedAt: number }
): SignInAgesJson {
  const shown = filterSignInAges(list, opts.dead);
  return {
    generatedAt: opts.generatedAt,
    generatedAtIso: iso(opts.generatedAt),
    rows: shown.rows.map(jsonRow),
    past: shown.past.map(jsonPast),
    coverage: shown.coverage,
  };
}

export interface SignInAgesDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  write?: (text: string) => void;
  serverUrl?: string;
  /**
   * The JWT for the server (test seam). Production uses `authenticateCli`, the
   * house login (#5136): `CLI_API_TOKEN`, else this instance's `settings.json`
   * token, which it sends only to a loopback server URL, with no proxy and no
   * redirect, and it exits 1 naming the cause when neither can be used.
   */
  authenticate?: () => Promise<string>;
}

/**
 * The aggregate's node rows, each parsed on its own like the web's read: an
 * entry this build cannot read is dropped and counted into the row's
 * `rejectedEntries` (so it is listed under coverage), and a reply that is not
 * an envelope fails with a clear message.
 */
export function parseHealthNodes(body: unknown): NodeAccountHealth[] {
  const raw = (body as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(raw)) {
    throw new Error("unexpected account-health reply (no nodes list)");
  }
  const nodes: NodeAccountHealth[] = [];
  for (const row of raw) {
    const parsed = parseNodeAccountHealthPerEntry(row);
    if (!parsed)
      throw new Error(
        "unexpected account-health reply (a node row did not parse)"
      );
    nodes.push(parsed);
  }
  return nodes;
}

/** Read the aggregate and print the list. Exit 0 on a read, 1 when it fails. */
export async function runSignInAges(
  flags: SignInAgesFlags,
  deps: SignInAgesDeps = {}
): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const write = deps.write ?? writeStdout;
  const serverUrl = deps.serverUrl ?? configuration.serverUrl;
  try {
    const token = await (deps.authenticate ?? authenticateCli)();
    const resp = await fetchImpl(`${serverUrl}/api/federation/account-health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error(`account-health HTTP ${resp.status}`);
    const nodes = parseHealthNodes(await resp.json());
    const generatedAt = (deps.now ?? Date.now)();
    const list = listSignInAges(nodes, generatedAt);
    write(
      flags.json
        ? JSON.stringify(
            toSignInAgesJson(list, { dead: flags.dead, generatedAt }),
            null,
            2
          )
        : formatSignInAgesTable(list, { dead: flags.dead })
    );
    return 0;
  } catch (err) {
    console.error(
      `Error: sign-in-ages failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
}
