// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `ServerExtensionHostImpl` — the object a server-side extension's `register`
 * function receives (issue #1266, Sub-Issue B of epic #1264).
 *
 * A thin facade over the existing core services (Store, ErrorLogger, and the
 * late-bound SyncEngine / PushService / NotificationHub / … ). Extensions never
 * import core modules directly — they only touch this host. The host is
 * deliberately NOT wired into `server/src/index.ts` here; that is Sub-Issue F's
 * loader work (R11). This PR ships the implementation, its unit tests, and the
 * supporting `Store` / `ErrorLogger` additions.
 *
 * Design invariants (locked host contract, 2026-06-10 reconciliation):
 * - **One host instance PER extension** — `deps.extensionId` + `deps.manifest`
 *   are eager (per-instance); the loader (F) builds a fresh host per extension
 *   and aggregates the internal getters across all of them.
 * - **Late-binding via getter functions** — every core dependency is resolved
 *   at call time, never at construction (matches the route-factory pattern in
 *   `server/src/web/routes/*.ts`). This lets the host be built before core
 *   services exist (R10).
 * - **The extension event bus is FULLY separate from sync events** — `events`
 *   carries only extension-emitted {@link ExtensionEvent}s and never reaches the
 *   SSE wire protocol. Extensions that need sync events use the late-bound
 *   {@link ServerExtensionHostImpl.getSyncEngine} accessor.
 */
import type {
  AgentBackend,
  AgentBackendFactory,
  ExtensionEvent,
  ExtensionEventListener,
  ExtensionLogger,
  ExtensionMigration,
  ExtensionTableSpec,
  HapiExtensionManifest,
  HonoRouteFactory,
  NotificationChannel,
  ServerExtensionHost,
} from "@hapi/protocol/ext";
import { type CapabilityGate } from "@hapi/protocol/ext";
import type { CatalogEntry } from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { Store } from "../store";
import { buildExtensionCatalogEntry } from "./capabilitiesFacade";

/**
 * The slice of Sub-Issue E's extension-prefs API that B consumes. E owns the
 * full `extension_prefs` store; B needs only the null-returning read
 * (`getOrNull`) per the locked contract §4 (2026-06-10). `get(id, default)`
 * (which synthesizes a default record and never returns null) is deliberately
 * NOT part of this slice — it is the wrong call for null-detection.
 */
export interface ExtensionPrefsApi {
  getOrNull(id: string): { config: Record<string, unknown> | null } | null;
}

/**
 * Constructor dependencies for {@link ServerExtensionHostImpl}.
 *
 * `extensionId` + `manifest` are eager (known when the loader builds the host).
 * Every core service is a **getter** resolved at method-call time, never at
 * construction (R10, R13). The eight opaque core accessors return `unknown` to
 * mirror A's `ServerExtensionHost` interface — the loader (F) narrows them at
 * the wiring site; each may return `null` before boot completes.
 */
export interface ServerExtensionHostDeps {
  extensionId: string;
  manifest: HapiExtensionManifest;
  /**
   * Per-extension capability gate (issue #1291, ADR-0003). Built by the loader
   * from the extension's declared `manifest.capabilities` + its PROVENANCE
   * (build-composed extensions are trusted and bypass the gate; runtime
   * filesystem extensions are default-deny gated). The privileged methods below
   * call `capabilityGate.require(...)` before granting access.
   */
  capabilityGate: CapabilityGate;
  getStore: () => Store;
  getErrorLogger: () => ErrorLogger;
  /** Sub-Issue E supplies this; `null` until E is wired (R4). */
  getExtensionPrefs: () => ExtensionPrefsApi | null;
  getSyncEngine: () => unknown;
  getPushService: () => unknown;
  getNotificationHub: () => unknown;
  getSystemEventQueue: () => unknown;
  getRpcRegistry: () => unknown;
  getNodeRegistry: () => unknown;
  getFederationApiToken: () => string | null;
  /** Process-wide `JobRegistry` (#1963) — see `ServerExtensionHost`. */
  getJobRegistry: () => unknown;
  /** Federation nodeId for supervised-loop grouping (#1963). */
  getJobNodeId: () => string;
  /** Raw `bun:sqlite` Database for extension store classes. */
  getRawDb: () => unknown;
  /**
   * Core server `Configuration`. Added by the pilot migration (#1271) — the
   * `config` facade above reads the extension's own `extension_prefs` row, so
   * extensions needing CORE settings (`telegramBotToken`, `telegramEnabled`,
   * `miniAppUrl`) had no route to them before this accessor.
   */
  getCoreConfig: () => unknown;
}

/** Table names an extension may contribute — no quotes, no leading digit. */
const VALID_TABLE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export class ServerExtensionHostImpl implements ServerExtensionHost {
  private readonly deps: ServerExtensionHostDeps;
  /**
   * `deps.extensionId` sanitized for use in table prefixes and log tags,
   * computed ONCE at construction: `[^a-zA-Z0-9] -> _`, lowercased.
   */
  private readonly sanitizedId: string;

  // ---- internal registries (one host instance PER extension) ----
  private readonly registeredChannels: NotificationChannel[] = [];
  private readonly registeredAgents = new Map<string, AgentBackendFactory>();
  private readonly registeredRouteFactories: HonoRouteFactory[] = [];
  private readonly registeredCatalogEntries: CatalogEntry[] = [];
  private readonly subscribers = new Set<ExtensionEventListener>();
  private readonly startupCallbacks: Array<() => void | Promise<void>> = [];
  private readonly shutdownCallbacks: Array<() => void | Promise<void>> = [];
  private readonly serviceHandles = new Map<string, unknown>();
  /** Memoized child logger — resolved lazily on first `log` access. */
  private cachedLog: ExtensionLogger | null = null;

  constructor(deps: ServerExtensionHostDeps) {
    this.deps = deps;
    this.sanitizedId = deps.extensionId
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toLowerCase();
  }

  // ---- notifications (R1) ----
  readonly notifications = {
    /** Accumulate a channel; NotificationHub is NOT touched at registration. */
    addChannel: (channel: NotificationChannel): void => {
      this.deps.capabilityGate.require(
        "notifications",
        "notifications.addChannel"
      );
      this.registeredChannels.push(channel);
    },
  };

  /** Internal getter for the loader (Sub-Issue F). */
  getRegisteredChannels(): readonly NotificationChannel[] {
    return this.registeredChannels;
  }

  // ---- agents (R8) ----
  readonly agents = {
    register: (id: string, factory: AgentBackendFactory): void => {
      this.deps.capabilityGate.require("agents", "agents.register");
      if (this.registeredAgents.has(id)) {
        throw new Error(
          `[ext:${this.deps.extensionId}] agent "${id}" is already registered.`
        );
      }
      this.registeredAgents.set(id, factory);
    },
    /** Sorted list of registered agent ids. */
    list: (): string[] => [...this.registeredAgents.keys()].sort(),
    /** Invoke a registered agent factory; throws for an unknown id. */
    create: (id: string): AgentBackend => {
      const factory = this.registeredAgents.get(id);
      if (!factory) {
        throw new Error(
          `[ext:${this.deps.extensionId}] agent "${id}" is not registered.`
        );
      }
      return factory();
    },
  };

  // ---- routes (R9) ----
  readonly routes = {
    add: (factory: HonoRouteFactory): void => {
      this.deps.capabilityGate.require("http.routes", "routes.add");
      this.registeredRouteFactories.push(factory);
    },
  };

  /** Internal getter for the loader (Sub-Issue F). */
  getRegisteredRouteFactories(): readonly HonoRouteFactory[] {
    return this.registeredRouteFactories;
  }

  // ---- capability catalog (#3752, R1) — SERVER-ONLY facade ----
  readonly capabilities = {
    /**
     * Contribute a capability-catalog entry. Gated on `catalog.contribute`
     * (default-deny). The entry is schema-validated + owner-stamped by
     * {@link buildExtensionCatalogEntry} (which throws on an invalid / `<script>`
     * entry); `trusted` is stamped later from provenance at the loader drain.
     */
    add: (entry: CatalogEntry): void => {
      this.deps.capabilityGate.require(
        "catalog.contribute",
        "capabilities.add"
      );
      this.registeredCatalogEntries.push(
        buildExtensionCatalogEntry(entry, this.deps.extensionId)
      );
    },
  };

  /** Internal getter for the loader (#3752): owner-stamped, pre-`trusted`-stamp. */
  getRegisteredCatalogEntries(): readonly CatalogEntry[] {
    return this.registeredCatalogEntries;
  }

  // ---- store (R2, R3) ----
  readonly store = {
    /**
     * Queue a `CREATE TABLE IF NOT EXISTS ext_<sanitizedId>_<tableName>` (R2).
     * The migration is registered on the core Store but runs only when F's
     * loader calls `Store.runExtensionMigrations()` (after core migrations).
     */
    addTable: (spec: ExtensionTableSpec): void => {
      this.deps.capabilityGate.require("store", "store.addTable");
      if (!VALID_TABLE_NAME.test(spec.tableName)) {
        throw new Error(
          `[ext:${this.deps.extensionId}] invalid table name "${spec.tableName}": ` +
            "must match /^[a-zA-Z][a-zA-Z0-9_]*$/ (no quotes, spaces, or leading digit)."
        );
      }
      const prefixedName = `ext_${this.sanitizedId}_${spec.tableName}`;
      this.deps.getStore().registerExtensionMigration(db => {
        db.exec(`CREATE TABLE IF NOT EXISTS ${prefixedName} (${spec.schema})`);
      });
    },
    /**
     * Register a full extension-authored migration (R3). A's
     * {@link ExtensionMigration} is a versioned object `{ version, up }`; the
     * host registers its `up` function with the core Store. `version` is
     * metadata (extension-authored idempotency / auditing) — the Store runs
     * extension migrations in registration order.
     */
    addMigration: (migration: ExtensionMigration): void => {
      this.deps.capabilityGate.require("store", "store.addMigration");
      this.deps.getStore().registerExtensionMigration(db => {
        migration.up(db);
      });
    },
  };

  // ---- events — extension bus, DISTINCT from sync events (R6, R7) ----
  readonly events = {
    subscribe: (listener: ExtensionEventListener): (() => void) => {
      this.subscribers.add(listener);
      return () => {
        this.subscribers.delete(listener);
      };
    },
    /**
     * Broadcast to extension-bus subscribers ONLY — never to SSE clients. Each
     * listener runs in its own try/catch so one bad subscriber cannot abort the
     * loop (R-sub-5); a snapshot is iterated so subscribe/unsubscribe during
     * emit is safe.
     */
    emit: (event: ExtensionEvent): void => {
      for (const listener of [...this.subscribers]) {
        try {
          listener(event);
        } catch (error) {
          try {
            this.log.error(`event listener threw for event "${event.type}"`, {
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Logging must never abort the emit loop.
          }
        }
      }
    },
  };

  // ---- config (R4) ----
  readonly config = {
    get: <T = unknown>(): T => {
      const prefs = this.deps.getExtensionPrefs();
      if (!prefs) {
        throw new Error(
          `[ext:${this.deps.extensionId}] config.get() is unavailable: ` +
            "the extension_prefs store (Sub-Issue E) is not yet wired."
        );
      }
      const row = prefs.getOrNull(this.deps.extensionId);
      const rawConfig = row?.config ?? undefined;
      const schema = this.deps.manifest.configSchema;
      if (schema) {
        const result = schema.safeParse(rawConfig);
        if (!result.success) {
          throw new Error(
            `[ext:${this.deps.extensionId}] config validation failed: ` +
              result.error.message
          );
        }
        return result.data as T;
      }
      return rawConfig as T;
    },
  };

  // ---- lifecycle (R12) — collected here, drained by F's loader ----
  readonly lifecycle = {
    onStartup: (cb: () => void | Promise<void>): void => {
      this.startupCallbacks.push(cb);
    },
    onShutdown: (cb: () => void | Promise<void>): void => {
      this.shutdownCallbacks.push(cb);
    },
  };

  /**
   * Internal getter for the loader (Sub-Issue F). Returns the LIVE map, not a
   * copy — handles registered later (an extension typically publishes its
   * service from inside its `onStartup` callback, after the loader has already
   * returned) must still be resolvable through the loader's aggregate.
   */
  getRegisteredServices(): ReadonlyMap<string, unknown> {
    return this.serviceHandles;
  }

  /** Internal getter for the loader (Sub-Issue F). */
  getStartupCallbacks(): ReadonlyArray<() => void | Promise<void>> {
    return this.startupCallbacks;
  }

  /** Internal getter for the loader (Sub-Issue F). */
  getShutdownCallbacks(): ReadonlyArray<() => void | Promise<void>> {
    return this.shutdownCallbacks;
  }

  // ---- late-bound core accessors (R13) — may return null pre-boot ----
  getSyncEngine(): unknown {
    this.deps.capabilityGate.require("core.internals", "getSyncEngine");
    return this.deps.getSyncEngine();
  }

  getPushService(): unknown {
    this.deps.capabilityGate.require("core.internals", "getPushService");
    return this.deps.getPushService();
  }

  getNotificationHub(): unknown {
    this.deps.capabilityGate.require("core.internals", "getNotificationHub");
    return this.deps.getNotificationHub();
  }

  getSystemEventQueue(): unknown {
    this.deps.capabilityGate.require("core.internals", "getSystemEventQueue");
    return this.deps.getSystemEventQueue();
  }

  getRpcRegistry(): unknown {
    this.deps.capabilityGate.require("core.internals", "getRpcRegistry");
    return this.deps.getRpcRegistry();
  }

  getNodeRegistry(): unknown {
    this.deps.capabilityGate.require("core.internals", "getNodeRegistry");
    return this.deps.getNodeRegistry();
  }

  getFederationApiToken(): string | null {
    this.deps.capabilityGate.require(
      "secrets.federationToken",
      "getFederationApiToken"
    );
    return this.deps.getFederationApiToken();
  }

  getJobRegistry(): unknown {
    this.deps.capabilityGate.require("core.internals", "getJobRegistry");
    return this.deps.getJobRegistry();
  }

  getJobNodeId(): string {
    // Ambient — returns only a node-id string (no privileged handle).
    return this.deps.getJobNodeId();
  }

  getRawDb(): unknown {
    this.deps.capabilityGate.require("store.raw", "getRawDb");
    return this.deps.getRawDb();
  }

  // ---- core-surface accessors (#1271 contract amendment) ----
  // `getStore`/`getErrorLogger` already existed in `deps` (consumed internally
  // by `store.*` and `log`); #1271 exposes them publicly so an extension whose
  // constructor predates the host (e.g. HappyBot) can be constructed unchanged.
  getCoreConfig(): unknown {
    this.deps.capabilityGate.require("core.config", "getCoreConfig");
    return this.deps.getCoreConfig();
  }

  getStore(): unknown {
    this.deps.capabilityGate.require("core.internals", "getStore");
    return this.deps.getStore();
  }

  getErrorLogger(): unknown {
    this.deps.capabilityGate.require("core.internals", "getErrorLogger");
    return this.deps.getErrorLogger();
  }

  // ---- cross-extension services registry (R14) ----
  readonly services = {
    register: (id: string, handle: unknown): void => {
      if (this.serviceHandles.has(id)) {
        throw new Error(
          `[ext:${this.deps.extensionId}] service "${id}" is already registered.`
        );
      }
      this.serviceHandles.set(id, handle);
    },
    get: <T = unknown>(id: string): T | null => {
      return this.serviceHandles.has(id)
        ? (this.serviceHandles.get(id) as T)
        : null;
    },
  };

  // ---- log (R5) — lazy memoized child logger, resolved at first access ----
  get log(): ExtensionLogger {
    return (this.cachedLog ??= this.deps
      .getErrorLogger()
      .child(this.deps.extensionId));
  }
}
