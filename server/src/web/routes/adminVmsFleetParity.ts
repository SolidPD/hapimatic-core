// SPDX-License-Identifier: AGPL-3.0-only
// GET /admin-vms/fleet-parity (#6300 PR-4, Task 19): RP1's nightly fleet parity
// verdict (`verdict.json`, written by scripts/fleet-parity-sweep-v1.sh), projected
// onto what the status page's Fleet parity panel shows. Split out of adminVms.ts,
// which only mounts it (that file is near its max-lines cap).
//
// The projection serves counts, never names, where a string would be a secret's
// name or an account: a `secret-names-missing` item's `item` is a secret's name,
// and the `fleet-parity-secret-names` and `fleet-parity-login` messages name
// secrets and accounts. Every other string is bounded, and any email or full uuid
// in one is withheld. Reads never throw (the adminVmsParityStatus.ts pattern).
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import {
  FLEET_PARITY_ITEM_ORDER,
  FLEET_PARITY_ITEMS_MAX,
  FLEET_PARITY_NODE_STATES,
  FLEET_PARITY_STALE_AFTER_MS,
  FleetParityVerdictSchema,
  type FleetParityAction,
  type FleetParityEngine,
  type FleetParityItem,
  type FleetParityNode,
  type FleetParityVerdict,
} from "@hapi/protocol/adminVms";
import { cataloged } from "../../capabilities/cataloged";
import type { ProvisionerHandle } from "../../provisioner";
import type { WebAppEnv } from "../middleware/auth";

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const SECRET_NAMES_CAUSE = "secret-names-missing";
/** Classes whose message names secrets or accounts: served as a count. */
const COUNTED_CLASSES = new Set([
  "fleet-parity-secret-names",
  "fleet-parity-login",
]);
const TOKEN = /\S+/g;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ACCOUNT_PREFIX = /\b[0-9a-f]{8}\b/g;

const nullableString = z.string().nullable().optional();
const nullableInt = z.number().int().nonnegative().nullable().optional();

/**
 * INPUT schema for verdict.json (fleet-parity.md, "The judge (P9)"). Not
 * `.strict()`: the judge adds fields without bumping `schema_version`, so
 * unknown keys are stripped, never fatal; a rename or retype bumps the version.
 */
const InputItemSchema = z.object({
  probe: z.string(),
  item: z.string(),
  cause: z.string(),
  disposition: z.enum(FLEET_PARITY_NODE_STATES),
  first_failing_at: nullableString,
});
const InputActionSchema = z.object({
  class: z.string(),
  message: z.string(),
  what_to_do: z.string().optional(),
  judged: z.boolean(),
});
const InputEngineSchema = z.object({
  installed: z.boolean(),
  healthy: z.boolean(),
  checked_at: nullableString,
  result: nullableString,
  consecutive_failures: nullableInt,
  hold: z.boolean(),
  rejection: z
    .object({ first_commit: z.string(), at: z.string() })
    .nullable()
    .optional(),
});
const InputNodeSchema = z.object({
  state: z.enum(FLEET_PARITY_NODE_STATES),
  is_vm: z.boolean(),
  contacted: z.boolean(),
  cause: nullableString,
  last_contacted_at: nullableString,
  rp1_home_sha: nullableString,
  commits_behind: nullableInt,
  session_days: nullableInt,
  engine: InputEngineSchema.nullable().optional(),
  items: z.array(InputItemSchema),
  actions: z.array(InputActionSchema),
});
const InputVerdictSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("fleet-parity-verdict"),
  run_id: z.string(),
  checked_at: z.string().regex(UTC_TIME),
  nodes: z.record(z.string(), InputNodeSchema),
});
type InputNode = z.infer<typeof InputNodeSchema>;

/** An operator VM's SSH login, which the remedies name; never a mailbox. */
const VM_SSH_TARGET = /^hapimatic@[a-z0-9-]+\.hapimatic\.com[.,;:)]?$/;

/** A whitespace-free token with text before an `@` and a dot after it reads as an email. */
function emailLike(token: string): boolean {
  if (VM_SSH_TARGET.test(token)) return false;
  const at = token.indexOf("@");
  return at > 0 && token.indexOf(".", at + 2) > at + 1;
}

/** A served string: emails and full uuids withheld, then cut to `max`. */
function bounded(text: string, max: number): string {
  const clean = text
    .replace(TOKEN, tok => (emailLike(tok) ? "(email withheld)" : tok))
    .replace(UUID, "(account withheld)");
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function boundedOrNull(
  text: string | null | undefined,
  max: number
): string | null {
  return typeof text === "string" ? bounded(text, max) : null;
}

/** A commit id is served only as hex, so no other string rides in that field. */
function commitOrNull(sha: string | null | undefined): string | null {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

function projectItems(node: InputNode): FleetParityItem[] {
  const out: FleetParityItem[] = [];
  const counted = new Map<string, FleetParityItem>();
  for (const it of node.items) {
    if (it.cause === SECRET_NAMES_CAUSE) {
      // Each such item is a secret's name: count them, per probe and disposition.
      const key = `${it.probe}\u0000${it.disposition}`;
      const seen = counted.get(key);
      if (seen) {
        seen.count += 1;
      } else {
        const entry: FleetParityItem = {
          probe: bounded(it.probe, 64),
          item: null,
          count: 1,
          cause: SECRET_NAMES_CAUSE,
          disposition: it.disposition,
          firstFailingAt: boundedOrNull(it.first_failing_at, 32),
        };
        counted.set(key, entry);
        out.push(entry);
      }
      continue;
    }
    out.push({
      probe: bounded(it.probe, 64),
      item: bounded(it.item, 128),
      count: 1,
      cause: bounded(it.cause, 128),
      disposition: it.disposition,
      firstFailingAt: boundedOrNull(it.first_failing_at, 32),
    });
  }
  // Most urgent first, so projectNode's cap drops only the least urgent (#6300 round 4).
  return out.sort(
    (a, b) =>
      FLEET_PARITY_ITEM_ORDER[a.disposition] -
      FLEET_PARITY_ITEM_ORDER[b.disposition]
  );
}

function projectActions(node: InputNode): FleetParityAction[] {
  const secretNames = node.items.filter(
    it => it.cause === SECRET_NAMES_CAUSE
  ).length;
  return node.actions.slice(0, 50).map(a => {
    let count: number | null = null;
    if (a.class === "fleet-parity-secret-names") count = secretNames;
    if (a.class === "fleet-parity-login") {
      count = new Set(a.message.match(ACCOUNT_PREFIX) ?? []).size;
    }
    return {
      class: bounded(a.class, 64),
      message: COUNTED_CLASSES.has(a.class) ? null : bounded(a.message, 600),
      count,
      whatToDo: bounded(a.what_to_do ?? "", 4000),
      judged: a.judged,
    };
  });
}

function projectEngine(node: InputNode): FleetParityEngine | null {
  const e = node.engine;
  if (!e || !e.installed) return null;
  return {
    installed: e.installed,
    healthy: e.healthy,
    lastTickAt: boundedOrNull(e.checked_at, 32),
    result: boundedOrNull(e.result, 64),
    consecutiveFailures: e.consecutive_failures ?? null,
    hold: e.hold,
    rejection: e.rejection
      ? {
          firstCommit: commitOrNull(e.rejection.first_commit) ?? "unknown",
          at: bounded(e.rejection.at, 32),
        }
      : null,
  };
}

function projectNode(name: string, node: InputNode): FleetParityNode {
  const items = projectItems(node);
  return {
    name: bounded(name, 64),
    state: node.state,
    isVm: node.is_vm,
    contacted: node.contacted,
    cause: boundedOrNull(node.cause, 128),
    lastContactedAt: boundedOrNull(node.last_contacted_at, 32),
    commit: commitOrNull(node.rp1_home_sha),
    commitsBehind: node.commits_behind ?? null,
    sessionDays: node.session_days ?? null,
    engine: projectEngine(node),
    items: items.slice(0, FLEET_PARITY_ITEMS_MAX),
    itemsOmitted: Math.max(0, items.length - FLEET_PARITY_ITEMS_MAX),
    actions: projectActions(node),
  };
}

/**
 * Project verdict.json's text onto the response. Pure. Anything that fails the
 * input schema, or has an unparsable `checked_at`, is `unreadable`.
 */
export function projectFleetParityVerdict(
  text: string,
  nowMs: number
): FleetParityVerdict {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: "unreadable" };
  }
  const parsed = InputVerdictSchema.safeParse(json);
  if (!parsed.success) return { state: "unreadable" };
  const v = parsed.data;
  const checkedMs = Date.parse(v.checked_at);
  if (!Number.isFinite(checkedMs)) return { state: "unreadable" };
  return {
    state: "ok",
    runId: bounded(v.run_id, 64),
    checkedAt: v.checked_at,
    stale: nowMs - checkedMs > FLEET_PARITY_STALE_AFTER_MS,
    nodes: Object.entries(v.nodes)
      .slice(0, 64)
      .map(([name, node]) => projectNode(name, node)),
  };
}

/** The sweep's state folder: $HAPI_FLEET_PARITY_STATE, else ~/.local/state/hapimatic/fleet-parity. */
export function resolveFleetParityStateDir(
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    env.HAPI_FLEET_PARITY_STATE ||
    join(homedir(), ".local", "state", "hapimatic", "fleet-parity")
  );
}

export interface FleetParityRouteDeps {
  provisioner: ProvisionerHandle;
  now: () => number;
  /** The sweep's state folder (default {@link resolveFleetParityStateDir}). */
  stateDir?: string;
  /** verdict.json reader (default `node:fs`); THROWS when the file is missing. */
  readVerdict?: (path: string) => Promise<string>;
}

/**
 * Register `GET /admin-vms/fleet-parity` on the admin-VMs app, after its
 * path-scoped capability guard. Never throws: a missing file is `absent`, any
 * other read failure or a file that fails the input schema is `unreadable`.
 */
export function registerFleetParityRoute(
  app: Hono<WebAppEnv>,
  deps: FleetParityRouteDeps
): void {
  const stateDir = deps.stateDir ?? resolveFleetParityStateDir();
  const readVerdict = deps.readVerdict ?? (p => readFile(p, "utf8"));
  app.get(
    "/admin-vms/fleet-parity",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-fleet-parity",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return RP1's nightly fleet parity verdict for the status page: per node its state, commit, last check, engine, failing items and actions with remedies; secret and account names as counts.",
        whenToUse:
          "When the operator wants to see which nodes are at parity, which are being repaired, and which need a person.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/fleet-parity",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!deps.provisioner.enabled) return c.notFound();
      let body: FleetParityVerdict;
      try {
        const text = await readVerdict(join(stateDir, "verdict.json"));
        body = projectFleetParityVerdict(text, deps.now());
      } catch (err) {
        body =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? { state: "absent" }
            : { state: "unreadable" };
      }
      try {
        // OUTPUT allowlist enforcement, as on /inventory: a stray field 500s.
        return c.json(FleetParityVerdictSchema.parse(body));
      } catch {
        return c.json({ error: "fleet parity serialization failed" }, 500);
      }
    }
  );
}
