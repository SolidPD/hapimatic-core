// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contribution-point types for the Hapimatic extension system (v0.1).
 *
 * These are the argument shapes the host interfaces (`hosts.ts`) accept when an
 * extension contributes a channel, command, route, table, event listener, etc.
 * Types that mirror a concrete server/cli internal are declared here
 * *structurally* rather than imported, because `shared` cannot depend on
 * server/cli/web without a circular dependency — sub-issues B/C/D satisfy these
 * shapes structurally at their host-implementation sites.
 *
 * Opaque `unknown` placeholders (`ToolViewLike`, `HonoRouteFactory<TDeps>`, the
 * slot `render` fields) are intentional: their concrete types live in
 * web/server/cli. Consumers must narrow before use.
 */
import type { Session, SyncEvent } from "../schemas";
import type {
  CatalogHarnessManifest,
  HarnessDriverBinding,
  HarnessInstallRecipe,
} from "../harnessRecipe";

/**
 * A notification channel an extension can register on the server host.
 * Structural match for `server/src/notifications/notificationTypes.ts`
 * `NotificationChannel` (redeclared to avoid a `shared` → `server` dependency).
 */
export interface NotificationChannel {
  sendReady: (session: Session) => Promise<void>;
  sendPermissionRequest: (session: Session) => Promise<void>;
  sendQuestion?: (session: Session, questionSummary: string) => Promise<void>;
  sendError?: (session: Session, errorMessage: string) => Promise<void>;
}

/**
 * Invocation context passed to a CLI command's `run`. Structural match for
 * `cli/src/commands/types.ts` `CommandContext`.
 */
export interface CommandContext {
  args: string[];
  subcommand?: string;
  commandArgs: string[];
}

/**
 * A CLI command an extension can register. Structural match for
 * `cli/src/commands/types.ts` `CommandDefinition`.
 */
export interface CommandDefinition {
  name: string;
  requiresRuntimeAssets: boolean;
  run: (context: CommandContext) => Promise<void>;
}

/**
 * Minimal opaque shape for an agent backend an extension can register. The
 * concrete `AgentBackend` in `cli/src/agent/types.ts` is wider; sub-issues B/D
 * satisfy this structurally without widening the shared contract.
 */
export interface AgentBackend {
  readonly id: string;
}

/** Factory producing an {@link AgentBackend}. */
export type AgentBackendFactory = () => AgentBackend;

/**
 * A CLI-harness contribution (HAL catalog, epic #3117 Sub-D / issue #3120). An extension
 * contributes one catalog CLI harness to the `CliExtensionHost.harness` surface: how to
 * install it ({@link HarnessInstallRecipe}), what it can do ({@link CatalogHarnessManifest},
 * the #3118 axis shape with an ID-OPEN `agentId` per ruling D8b/KD5), and how HAL binds a
 * driver to it once installed.
 *
 * `id` is the OPEN catalog harness id (`"crush"`, `"cursor"`, …) — a plain string,
 * mirroring {@link AgentBackend.id}. It is DELIBERATELY not an `AgentFlavor`: the stock 4
 * stay a closed union (#3118), and catalog CLIs resolve via a SEPARATE resolver
 * (`resolveCatalogManifest`, cli-side), never through the stock-4 registry.
 *
 * Declared structurally (the recipe closures are typed but opaque to `shared`), matching
 * this file's rule that `shared` cannot depend on cli/server — the host narrows at its
 * implementation site.
 */
export interface HarnessContribution {
  id: string;
  installRecipe: HarnessInstallRecipe;
  capabilityManifest: CatalogHarnessManifest;
  driverBinding: HarnessDriverBinding;
}

/**
 * Opaque Hono route-factory shape. `TDeps` is left `unknown` because the
 * existing route factories (`server/src/web/routes/*.ts`) take varying
 * dependency tuples (epic risk R-sub-6). Sub-issue B narrows `TDeps` when it
 * defines the concrete `ServerExtensionHost.routes.add` signature.
 */
export type HonoRouteFactory<TDeps = unknown> = (deps: TDeps) => unknown;

/**
 * A SQLite table an extension contributes. `schema` is the body-only SQL between
 * the parens; the host emits
 * `CREATE TABLE IF NOT EXISTS ext_<sanitizedId>_<tableName> (<schema>)`, so an
 * extension can never bypass the per-extension `ext_<id>_` table prefix.
 * (Sub-issue E owns the core `extension_prefs` table separately.)
 */
export interface ExtensionTableSpec {
  tableName: string;
  schema: string;
}

/** A versioned migration an extension contributes for its own tables. */
export interface ExtensionMigration {
  version: number;
  up: (db: unknown) => void | Promise<void>;
}

/**
 * An event on the extension event bus. Deliberately distinct from `SyncEvent`:
 * extension events are server-internal and never enter the SSE wire protocol.
 */
export interface ExtensionEvent {
  type: string;
  payload?: unknown;
}

/** Listener for the extension event bus ({@link ExtensionEvent}). */
export type ExtensionEventListener = (event: ExtensionEvent) => void;

/**
 * Listener for sync-engine events. Re-uses `SyncEvent` from shared schemas.
 *
 * NOTE: this is NOT what `ServerExtensionHost.events.subscribe` accepts — that
 * bus is {@link ExtensionEventListener}-typed. `SyncEventListener` is for
 * extensions that reach the sync engine via the late-bound `getSyncEngine()`
 * accessor.
 */
export type SyncEventListener = (event: SyncEvent) => void;

/**
 * Minimal structural logger an extension receives via the server host's lazy
 * `log` member. Declared here (not in `hosts.ts`) so the server's concrete
 * `ErrorLogger.child()` can return it by structural typing — the concrete
 * `ErrorLogger` has private members and is nominally untypeable from an object
 * literal.
 */
export interface ExtensionLogger {
  log: (message: string, context?: unknown) => void;
  error: (message: string, context?: unknown) => void;
  warn: (message: string, context?: unknown) => void;
  info: (message: string, context?: unknown) => void;
  debug: (message: string, context?: unknown) => void;
}

/**
 * Opaque placeholder for a web tool-view component. Left `unknown` so `shared`
 * stays free of React. Sub-issue C narrows this to
 * `ComponentType<ToolViewProps>` at the web host-implementation level.
 */
export type ToolViewLike = unknown;

/**
 * A tab an extension contributes to the session-detail view. Net-new slot
 * infrastructure (epic risk R-sub-5); sub-issues T/U refine as they exercise it.
 * `order` is an ordering hint (lower = earlier).
 */
export interface SessionDetailTabSpec {
  id: string;
  label: string;
  order?: number;
  render: ToolViewLike;
}

/** An info field an extension contributes to the session-detail view. */
export interface SessionDetailInfoFieldSpec {
  id: string;
  label: string;
  order?: number;
  render: ToolViewLike;
}

/** An action button an extension contributes to the session-detail view. */
export interface SessionDetailActionSpec {
  id: string;
  label: string;
  order?: number;
  onClick: () => void | Promise<void>;
}

/** A preferences section an extension contributes to the settings surface. */
export interface PreferenceSectionSpec {
  id: string;
  label: string;
  order?: number;
  render: ToolViewLike;
}

/**
 * A navigation route an extension contributes to the web app. `path` is required
 * so the web loader (sub-issue F) can wire the actual route (#1281 R5 depends on
 * `path` existing here). `validateSearch` optionally validates/normalizes the
 * route's search params.
 */
export interface NavigationRouteSpec {
  id: string;
  label: string;
  order?: number;
  path: string;
  render: ToolViewLike;
  validateSearch?: (search: Record<string, unknown>) => Record<string, unknown>;
}
