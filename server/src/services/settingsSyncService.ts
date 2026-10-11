// SPDX-License-Identifier: AGPL-3.0-only
import { SupervisedLoop } from "@hapi/protocol";
import { z } from "zod";
import {
  ChatSectionsPreferenceSchema,
  DefaultOutputStylePreferenceSchema,
  TimeLogTimezoneSchema,
  TerminalKeyboardExpandedPreferenceSchema,
  FEDERATION_SETTING_KEYS,
  FederationSettingsBlockSchema,
  FederationSettingsSyncSchema,
  type FederationSettingKey,
  type FederationSettingsBlock,
  type FederationSettingProvenance,
  type FederationSettingsSync,
  type FederationSettingsView,
  type TimestampedValue,
} from "@hapi/protocol/schemas";
import { readSettings, writeSettings } from "../config/settings";

/**
 * Issue #2624 (Sub-Issue B of epic #2622): the federation-global settings layer.
 *
 * This service is the single choke point for the generic per-node settings model
 * — resolver, registry, last-write-wins merge, best-effort push fan-out, and the
 * self-healing reconcile backstop — mirroring the sibling
 * {@link ../services/outputStyleSyncService OutputStyleSyncService} (#2627, E)
 * for structural consistency. B differs from E only in its EXTRA semantics: a
 * per-setting inherit flag (🌐), node-local overrides, and the effective-value
 * resolver (E syncs file content by name; B syncs setting VALUES by key).
 *
 *  - **Storage** — a single `federationSettings` block in node `settings.json`:
 *    `{ globalValues: { key → { value, updatedAt, originNodeId? } }, localOverrides,
 *    inheritFlags }` (KD-3). A's own keys (`chatSectionsPreference` /
 *    `defaultOutputStylePreference`) stay as A's LOCAL storage — they are the
 *    resolver's fallback before any federation-global has ever been written (R2).
 *    B does NOT migrate A's stored values into `globalValues` (R9).
 *
 *  - **Transport** — hybrid push-on-write + poll-reconcile (KD-1). A global write
 *    fans out `POST /api/federation/settings-sync` best-effort to every peer; a
 *    dedicated {@link SupervisedLoop} pulls each peer's `GET
 *    /api/federation/settings-digest` on a cadence so a peer offline at push time
 *    converges after it rejoins (R6/R7). The reconcile is a self-owned loop
 *    (matching E) rather than a `nodeRegistry` poll-piggyback — same contract,
 *    lower blast radius, and it never touches the session poll.
 *
 *  - **Values stay opaque** (KD-4) — each setting's `value` is validated only by
 *    its REGISTERED Zod schema (e.g. `ChatSectionsPreferenceSchema`), never a
 *    hard-coded shape. Registering a future setting is one row in
 *    {@link SETTING_REGISTRY}, no new plumbing.
 *
 *  - **Only keys/values cross the wire, never tokens** (KD-6).
 */

/** One registry row: A's settings.json storage key (the resolver's per-node
 * fallback source, R2) + the Zod schema that validates this setting's value
 * shape (KD-4: the ONLY validator — the layer never hard-codes value shapes). */
export interface SettingRegistryEntry {
  /** A's `settings.json` key that holds this node's local value before any
   *  federation-global write exists (consumed by the route fallback). OPTIONAL:
   *  a federation-NATIVE key (e.g. `terminalKeyboardExpanded`, #4548) has no
   *  A-local storage — its only per-node value is a browser-side first-paint
   *  cache — so it registers no `storageKey`. */
  storageKey?: string;
  /** Validates the setting's value on the wire and on read (mixed-version
   *  defense, 2624-6). */
  schema: z.ZodTypeAny;
}

/** The registered settings, mapped to A's storage (when any) + schema. A future
 *  setting registers by adding one row here — nothing else changes. */
export const SETTING_REGISTRY: Record<
  FederationSettingKey,
  SettingRegistryEntry
> = {
  chatSections: {
    storageKey: "chatSectionsPreference",
    schema: ChatSectionsPreferenceSchema,
  },
  defaultOutputStyle: {
    storageKey: "defaultOutputStylePreference",
    schema: DefaultOutputStylePreferenceSchema,
  },
  // #4613: the one federation-wide time-log IANA timezone. `storageKey` is
  // documentation only (`resolveEffective` reads just `.schema`) — the A-local
  // fallback actually lives nested at `timeLogPreferences.timezone`, supplied to
  // `buildView` explicitly by the preferences route via `readLocalTimeLogTimezone`.
  timeLogTimezone: {
    storageKey: "timeLogPreferences",
    schema: TimeLogTimezoneSchema,
  },
  // Federation-native (#4548): no A-local storage; the per-node value is the
  // browser's first-paint cache (#4516), never a server settings.json key.
  terminalKeyboardExpanded: {
    schema: TerminalKeyboardExpandedPreferenceSchema,
  },
};

function isRegisteredKey(key: string): key is FederationSettingKey {
  return (FEDERATION_SETTING_KEYS as readonly string[]).includes(key);
}

// ── Pure resolution + merge functions (unit-testable, no I/O) ───────────────

/**
 * R1: THE single effective-value read path — `inherit ? global : override`.
 * Returns `undefined` when a key is inheriting with no federation-global written
 * yet, so the caller falls back to A's per-key default (R2). Additionally
 * `safeParse`s the resolved value against the registered schema and returns
 * `undefined` on failure, so an unvalidated peer value is never served to a
 * client during a mixed-version window (2624-6).
 */
export function resolveEffective(
  block: FederationSettingsBlock,
  key: FederationSettingKey
): unknown {
  const entry = SETTING_REGISTRY[key];
  if (!entry) return undefined;
  const inheriting = block.inheritFlags[key] !== false; // default ON (R2)
  const raw = inheriting
    ? block.globalValues[key]?.value
    : block.localOverrides[key];
  if (raw === undefined) return undefined;
  const parsed = entry.schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Per-key provenance of whatever {@link resolveEffective} returns — drives the
 *  browser 🌐 view. "default" whenever the effective value falls through to A's
 *  per-key default (inheriting-no-global, or an unresolvable/malformed value). */
export function provenanceOf(
  block: FederationSettingsBlock,
  key: FederationSettingKey
): FederationSettingProvenance {
  const inheriting = block.inheritFlags[key] !== false;
  if (resolveEffective(block, key) === undefined) return "default";
  return inheriting ? "global" : "local";
}

/**
 * LWW-merge an incoming digest into `globalValues` (R5/R10). A key is adopted
 * iff `incoming.updatedAt` is strictly greater than the local clock, OR on an
 * exact `updatedAt` tie iff the incoming `originNodeId` sorts strictly higher
 * (KD-2 tie-break, 2624-9 — without it two values written in the same
 * millisecond on two nodes never converge). Mixed-version defense (2624-6):
 * UNREGISTERED keys are skipped, and each value is `safeParse`d against its
 * registered schema — a value the local registry cannot validate is dropped.
 * Returns the merged block + the keys that actually changed (write-only-on-change).
 */
export function applyIncoming(
  block: FederationSettingsBlock,
  incoming: Record<string, TimestampedValue>
): { block: FederationSettingsBlock; changed: FederationSettingKey[] } {
  const changed: FederationSettingKey[] = [];
  const globalValues = { ...block.globalValues };
  for (const [key, incomingVal] of Object.entries(incoming)) {
    if (!isRegisteredKey(key)) continue; // newer peer pushed an unknown key
    if (!SETTING_REGISTRY[key].schema.safeParse(incomingVal.value).success) {
      continue; // a value this node's registry cannot validate — drop it
    }
    const local = globalValues[key];
    const wins =
      local === undefined ||
      incomingVal.updatedAt > local.updatedAt ||
      (incomingVal.updatedAt === local.updatedAt &&
        (incomingVal.originNodeId ?? "") > (local.originNodeId ?? ""));
    if (wins) {
      globalValues[key] = incomingVal;
      changed.push(key);
    }
  }
  return { block: { ...block, globalValues }, changed };
}

/** R3a: set the federation-global value with a fresh clock + origin (global write). */
export function writeGlobal(
  block: FederationSettingsBlock,
  key: FederationSettingKey,
  value: unknown,
  now: number,
  originNodeId: string | null
): FederationSettingsBlock {
  const stamped: TimestampedValue = {
    value,
    updatedAt: now,
    ...(originNodeId ? { originNodeId } : {}),
  };
  return {
    ...block,
    globalValues: { ...block.globalValues, [key]: stamped },
  };
}

/** R4: set a node-local override only (no propagation). */
export function writeLocalOverride(
  block: FederationSettingsBlock,
  key: FederationSettingKey,
  value: unknown
): FederationSettingsBlock {
  return {
    ...block,
    localOverrides: { ...block.localOverrides, [key]: value },
  };
}

/** R8: toggle the inherit flag. Turning 🌐 back ON re-adopts the current global
 *  on the next resolve (the local override is retained but ignored while
 *  inheriting, so toggling OFF again restores the last override). */
export function setInherit(
  block: FederationSettingsBlock,
  key: FederationSettingKey,
  inherit: boolean
): FederationSettingsBlock {
  return {
    ...block,
    inheritFlags: { ...block.inheritFlags, [key]: inherit },
  };
}

/**
 * Compose the browser-facing 🌐 view (R8). Pure: takes the block + the per-key
 * A-default fallbacks (the route supplies these from `readChatSections` /
 * `readDefaultOutputStyle`, which the service cannot import without a cycle).
 * `values[key]` is the effective value, or the A-fallback when provenance is
 * "default".
 */
export function buildView(
  block: FederationSettingsBlock,
  fallbacks: Partial<Record<FederationSettingKey, unknown>>
): FederationSettingsView {
  const values: Record<string, unknown> = {};
  const inheritFlags: Record<string, boolean> = {};
  const provenance: Record<string, FederationSettingProvenance> = {};
  for (const key of FEDERATION_SETTING_KEYS) {
    const eff = resolveEffective(block, key);
    values[key] = eff !== undefined ? eff : fallbacks[key];
    inheritFlags[key] = block.inheritFlags[key] !== false;
    provenance[key] = provenanceOf(block, key);
  }
  return { values, inheritFlags, provenance };
}

// ── Service (owns disk I/O, the write mutex, peers, and the reconcile loop) ──

/** A federation peer to push to / pull from. */
export interface SettingsSyncPeer {
  id: string;
  url: string;
}

/** Default cadence for the reconcile pull loop (matches E's output-style loop). */
export const SETTINGS_RECONCILE_INTERVAL_MS = 60_000;

export interface SettingsSyncServiceOptions {
  /** Absolute path to this node's `settings.json`. */
  settingsFile: string;
  /** Returns the current federation peers to push to / reconcile from. */
  resolvePeers?: () => SettingsSyncPeer[];
  /** This node's id — excluded from its own peer list and stamped as
   *  `originNodeId` on a global write (KD-2 tie-break). */
  localNodeId?: string | null;
  /** Federation token authenticating node-to-node push/pull. */
  apiToken?: string | null;
  /** Reconcile cadence. Defaults to {@link SETTINGS_RECONCILE_INTERVAL_MS}. */
  reconcileIntervalMs?: number;
  /** Injectable `fetch` (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export class SettingsSyncService {
  private readonly settingsFile: string;
  private readonly resolvePeersRaw: () => SettingsSyncPeer[];
  private readonly localNodeId: string | null;
  private readonly apiToken: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly loop: SupervisedLoop;

  /**
   * Serializes every `federationSettings` read→merge→write cycle (the browser
   * PUT path, the receiver's `applyRemote`, and the reconcile pull) through ONE
   * in-process promise chain (2624-3).
   *
   * NOTE: the expert-review's original rationale — a FIXED `settings.json.tmp`
   * collision — no longer applies: #2623 already made `writeSettings` use a
   * unique per-write temp path. The mutex is retained for the STILL-valid
   * reason: without it, two concurrent read→merge→write cycles both read the
   * block, both merge their own change, and the second `writeSettings` clobbers
   * the first's merged key (whole-file last-write-wins LOSES an update). The
   * chain makes each cycle read the latest block.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: SettingsSyncServiceOptions) {
    this.settingsFile = opts.settingsFile;
    this.resolvePeersRaw = opts.resolvePeers ?? (() => []);
    this.localNodeId = opts.localNodeId ?? null;
    this.apiToken = opts.apiToken ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());

    this.loop = new SupervisedLoop({
      name: "settings-reconcile",
      node: this.localNodeId ?? "local",
      intervalMs: opts.reconcileIntervalMs ?? SETTINGS_RECONCILE_INTERVAL_MS,
      immediate: false,
      tick: () => this.reconcileOnce(),
    });
  }

  getSettingsFile(): string {
    return this.settingsFile;
  }

  /** Read + parse the `federationSettings` block (no lock, no mutation). Returns
   *  an empty all-inheriting block when settings are missing OR malformed. */
  async readBlock(): Promise<FederationSettingsBlock> {
    const settings = await readSettings(this.settingsFile);
    const rec = (settings ?? {}) as Record<string, unknown>;
    return FederationSettingsBlockSchema.parse(rec.federationSettings ?? {});
  }

  // ── Mutating entry points (all serialize through the write chain) ──────────

  /** Receiver (Task 5) + reconcile (Task 9) entry point: LWW-merge an incoming
   *  digest and persist iff something changed. */
  async applyRemote(
    incoming: Record<string, TimestampedValue>
  ): Promise<{ changed: FederationSettingKey[] }> {
    return this.mutate(
      block => {
        const { block: next, changed } = applyIncoming(block, incoming);
        return {
          block: next,
          result: { changed },
          changed: changed.length > 0,
        };
      },
      () => ({ changed: [] as FederationSettingKey[] })
    );
  }

  /** R3: PUT while inheriting — persist the new federation-global value locally,
   *  then fan it out best-effort to every peer. */
  async writeGlobalValue(
    key: FederationSettingKey,
    value: unknown
  ): Promise<void> {
    const now = this.now();
    const wrote = await this.mutate(
      block => ({
        block: writeGlobal(block, key, value, now, this.localNodeId),
        result: true,
        changed: true,
      }),
      () => false
    );
    if (wrote) {
      await this.fanOutToPeers({
        [key]: {
          value,
          updatedAt: now,
          ...(this.localNodeId ? { originNodeId: this.localNodeId } : {}),
        },
      });
    }
  }

  /** R4: PUT while NOT inheriting — persist a node-local override only, no fan-out. */
  async writeLocalValue(
    key: FederationSettingKey,
    value: unknown
  ): Promise<void> {
    await this.mutate(
      block => ({
        block: writeLocalOverride(block, key, value),
        result: undefined,
        changed: true,
      }),
      () => undefined
    );
  }

  /** R8: flip the 🌐 inherit flag for a key. */
  async setInheritFlag(
    key: FederationSettingKey,
    inherit: boolean
  ): Promise<void> {
    await this.mutate(
      block => ({
        block: setInherit(block, key, inherit),
        result: undefined,
        changed: true,
      }),
      () => undefined
    );
  }

  /** This node's global digest (fed-token GET /federation/settings-digest). */
  async buildDigest(): Promise<FederationSettingsSync> {
    const block = await this.readBlock();
    return { values: block.globalValues };
  }

  // ── Federation transport ───────────────────────────────────────────────────

  /** Fan a set of changed globals out to every peer (best-effort, KD-1). */
  async fanOutToPeers(values: Record<string, TimestampedValue>): Promise<void> {
    const peers = this.peers();
    if (peers.length === 0) return;
    await Promise.allSettled(peers.map(peer => this.postToPeer(peer, values)));
  }

  /** Pull each peer's global digest and apply divergences under LWW (R6/R7).
   *  This is the offline-peer backstop the best-effort push alone cannot give. */
  async reconcileOnce(): Promise<void> {
    for (const peer of this.peers()) {
      try {
        const res = await this.fetchImpl(
          `${peer.url}/api/federation/settings-digest`,
          { headers: this.authHeaders(), signal: AbortSignal.timeout(5000) }
        );
        if (!res.ok) continue; // stale peer (404) / error — fail-open, skip
        const parsed = FederationSettingsSyncSchema.safeParse(await res.json());
        if (!parsed.success) continue; // garbled digest — skip
        await this.applyRemote(parsed.data.values);
      } catch (err) {
        console.warn(`[SettingsSync] reconcile from ${peer.id} failed:`, err);
      }
    }
  }

  /** Start the reconcile loop (only meaningful when federation has peers). */
  start(): void {
    if (this.loop.getStatus() === "stopped") this.loop.start();
  }

  /** Stop the reconcile loop (graceful shutdown). */
  stop(): void {
    this.loop.stop();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Serialize a read-block → mutate → conditional-write cycle through the write
   * chain. `fn` returns the next block, a caller result, and whether the block
   * changed (writes only on change — 2624-3). A malformed `settings.json`
   * (`readSettings` → `null`) is NOT overwritten (mirrors A's DO-NOT-WRITE
   * guard); `onUnreadable` supplies the no-op result in that case.
   */
  private mutate<T>(
    fn: (block: FederationSettingsBlock) => {
      block: FederationSettingsBlock;
      result: T;
      changed: boolean;
    },
    onUnreadable: () => T
  ): Promise<T> {
    const run = this.writeChain.then(() => this.runMutation(fn, onUnreadable));
    // Keep the chain alive even if this run rejects; the real result/rejection
    // still propagates to THIS caller via `run`.
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runMutation<T>(
    fn: (block: FederationSettingsBlock) => {
      block: FederationSettingsBlock;
      result: T;
      changed: boolean;
    },
    onUnreadable: () => T
  ): Promise<T> {
    const settings = await readSettings(this.settingsFile);
    if (settings === null) {
      console.warn(
        "[SettingsSync] settings.json unreadable — skipping federationSettings write"
      );
      return onUnreadable();
    }
    const rec = settings as Record<string, unknown>;
    const block = FederationSettingsBlockSchema.parse(
      rec.federationSettings ?? {}
    );
    const { block: next, result, changed } = fn(block);
    if (changed) {
      rec.federationSettings = next;
      await writeSettings(this.settingsFile, settings);
    }
    return result;
  }

  private peers(): SettingsSyncPeer[] {
    const seen = new Set<string>();
    const out: SettingsSyncPeer[] = [];
    for (const peer of this.resolvePeersRaw()) {
      if (!peer?.url || !peer.id) continue;
      if (peer.id === this.localNodeId) continue; // never push to self
      if (seen.has(peer.id)) continue;
      seen.add(peer.id);
      out.push(peer);
    }
    return out;
  }

  private authHeaders(): Record<string, string> {
    return this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {};
  }

  private async postToPeer(
    peer: SettingsSyncPeer,
    values: Record<string, TimestampedValue>
  ): Promise<void> {
    try {
      const res = await this.fetchImpl(
        `${peer.url}/api/federation/settings-sync`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders(),
          },
          body: JSON.stringify({ values }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) {
        // A stale-binary peer lacking the receiver 404s here — degrade cleanly
        // (R7); the reconcile pull is the convergence backstop.
        console.warn(`[SettingsSync] push to ${peer.id} → HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[SettingsSync] push to ${peer.id} failed:`, err);
    }
  }
}
