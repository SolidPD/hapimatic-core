// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extension host interfaces (v0.1) — the object an extension's `register`
 * function receives for each runtime (server / web / cli). Each host exposes the
 * contribution points from epic #1264's "Contribution points (v0.1)" table,
 * plus the reconciliation additions (locked contract §3, 2026-06-10).
 *
 * Methods that register a callback return an unsubscribe function `() => void`
 * where the subscription is revocable (`events.subscribe`,
 * `lifecycle.onSessionStart/End`). `lifecycle.onStartup`/`onShutdown` return
 * `void` (the loader drains them once — no unsubscribe semantics). Methods that
 * register a static contribution return `void`.
 */
import type { Session } from "../schemas";
import type { CatalogEntry } from "../capabilityCatalog";
import type {
  AgentBackendFactory,
  CommandDefinition,
  ExtensionEvent,
  ExtensionEventListener,
  ExtensionLogger,
  ExtensionMigration,
  ExtensionTableSpec,
  HarnessContribution,
  HonoRouteFactory,
  NavigationRouteSpec,
  NotificationChannel,
  PreferenceSectionSpec,
  SessionDetailActionSpec,
  SessionDetailInfoFieldSpec,
  SessionDetailTabSpec,
  ToolViewLike,
} from "./contributions";

/**
 * Server-side extension host.
 *
 * The late-bound core accessors (`getSyncEngine`, `getRawDb`, …) return `unknown`
 * (their concrete types live server-side — same opaque pattern as
 * `ToolViewLike`/`HonoRouteFactory`; sub-issue B narrows at the implementation
 * site) and **may be `null` before boot completes**. Long-running services must
 * start in `lifecycle.onStartup`, never in `register()`.
 */
export interface ServerExtensionHost {
  notifications: {
    addChannel(channel: NotificationChannel): void;
  };
  agents: {
    register(id: string, factory: AgentBackendFactory): void;
  };
  routes: {
    add(factory: HonoRouteFactory): void;
  };
  /**
   * Contribute a capability-catalog entry (issue #3752). The facade validates the
   * entry against `catalogEntrySchema`, stamps `owner = manifest.id`, and registers
   * it for the boot-time collector; the loader stamps `trusted` from provenance
   * (build-composed ⇒ the entry's value; filesystem ⇒ forced `false`) at its drain
   * site, and the entry is merged into the live Tier-1 catalog served by
   * `GET /api/capabilities/catalog`. Gated on the `catalog.contribute` privilege
   * (default-deny, ADR-0003 — the extension capability model IS the host-facade
   * access gate).
   *
   * SERVER-ONLY (ER 2026-09-16 3752-6): the CLI host is stateless and the web host a
   * singleton — neither carries a per-extension identity nor a live-catalog assembler
   * to reach — so this contribution point lives on the server host only.
   */
  capabilities: {
    add(entry: CatalogEntry): void;
  };
  store: {
    addTable(spec: ExtensionTableSpec): void;
    addMigration(migration: ExtensionMigration): void;
  };
  /**
   * The extension event bus — typed on {@link ExtensionEvent}, NOT on
   * `SyncEvent`. Extension events are server-internal and never reach the SSE
   * wire protocol.
   */
  events: {
    subscribe(listener: ExtensionEventListener): () => void;
    emit(event: ExtensionEvent): void;
  };
  config: {
    /** Extensions supply their own config type at the call site. */
    get<T = unknown>(): T;
  };
  /**
   * Lifecycle hooks drained once by the loader. `onStartup` callbacks run AFTER
   * all extensions' `register()` calls complete AND core services are
   * constructed (post-boot); `onShutdown` runs during graceful shutdown.
   */
  lifecycle: {
    onStartup(cb: () => void | Promise<void>): void;
    onShutdown(cb: () => void | Promise<void>): void;
  };

  // Late-bound core accessors — may return `null` before boot completes.
  getSyncEngine(): unknown;
  getPushService(): unknown;
  getNotificationHub(): unknown;
  getSystemEventQueue(): unknown;
  getRpcRegistry(): unknown;
  getNodeRegistry(): unknown;
  getFederationApiToken(): string | null;
  /**
   * The process-wide `JobRegistry` (#1963). An extension that owns a
   * `SupervisedLoop` registers with it so the loop appears in the System Jobs
   * portal alongside core's loops; without it the loop still ticks but is
   * invisible to job observability. Added by #1274, whose scheduler loop
   * predates the extension system.
   */
  getJobRegistry(): unknown;
  /**
   * Federation nodeId used to group supervised-loop rows per node
   * (`federationConfig.nodeId` ?? `"standalone"`). Pairs with
   * {@link getJobRegistry}.
   */
  getJobNodeId(): string;
  /** Raw `bun:sqlite` Database for extension store classes. */
  getRawDb(): unknown;
  /**
   * Core server configuration (the `Configuration` instance). Added by the
   * pilot migration (#1271): `host.config.get()` reads the extension's OWN
   * `extension_prefs` row, so it cannot serve extensions that need CORE
   * settings (`telegramBotToken`, `miniAppUrl`, …). Contract amendment
   * rationale is recorded on #1271.
   */
  getCoreConfig(): unknown;
  /** The core `Store` (extension-facing store classes needing typed sub-stores). */
  getStore(): unknown;
  /** The core `ErrorLogger` — for extensions whose types predate {@link log}. */
  getErrorLogger(): unknown;

  /** Cross-extension handle registry (e.g. scheduler publishes, heartbeat reads). */
  services: {
    register(id: string, handle: unknown): void;
    get<T = unknown>(id: string): T | null;
  };

  /**
   * Structural logger for the extension. Implemented server-side as a lazy
   * getter delegating to `ErrorLogger.child()` — declared here so extensions
   * get a typed logger without `shared` importing server code.
   */
  log: ExtensionLogger;
}

/** Web (frontend) extension host. */
export interface WebExtensionHost {
  toolViews: {
    addCompact(toolName: string, view: ToolViewLike): void;
    addFullInput(toolName: string, view: ToolViewLike): void;
    addResult(toolName: string, view: ToolViewLike): void;
  };
  sessionDetail: {
    addTab(spec: SessionDetailTabSpec): void;
    addInfoField(spec: SessionDetailInfoFieldSpec): void;
    addAction(spec: SessionDetailActionSpec): void;
  };
  preferences: {
    addSection(spec: PreferenceSectionSpec): void;
  };
  navigation: {
    addRoute(spec: NavigationRouteSpec): void;
  };
}

/** CLI extension host. */
export interface CliExtensionHost {
  commands: {
    add(definition: CommandDefinition): void;
  };
  agents: {
    register(id: string, factory: AgentBackendFactory): void;
  };
  /**
   * Register a catalog CLI harness (HAL, epic #3117 Sub-D / issue #3120). Gated on the
   * `"harness"` capability. `id` is the OPEN catalog harness id ({@link HarnessContribution.id});
   * the registration is resolvable via the cli-side `resolveCatalogManifest(id)`.
   */
  harness: {
    register(id: string, contribution: HarnessContribution): void;
  };
  lifecycle: {
    onSessionStart(cb: (session: Session) => void | Promise<void>): () => void;
    onSessionEnd(cb: (session: Session) => void | Promise<void>): () => void;
  };
}
