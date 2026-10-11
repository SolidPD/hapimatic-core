// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Core extension-manifest types and config-validation helpers.
 *
 * The manifest is a pure type-level contract; `validateExtensionConfig` /
 * `safeValidateExtensionConfig` are thin runtime wrappers over a
 * plugin-owned Zod schema (the manifest's `configSchema`).
 */
import { z } from "zod";
import type { Capability } from "./capabilities";
import type { CatalogEntry } from "../capabilityCatalog";
import type {
  CliExtensionHost,
  ServerExtensionHost,
  WebExtensionHost,
} from "./hosts";

/** Registration function invoked with the server extension host. */
export type ServerRegister = (
  host: ServerExtensionHost
) => Promise<void> | void;

/** Registration function invoked with the web extension host. */
export type WebRegister = (host: WebExtensionHost) => Promise<void> | void;

/** Registration function invoked with the cli extension host. */
export type CliRegister = (host: CliExtensionHost) => Promise<void> | void;

/**
 * Static manifest an extension package exports — the v0.1 extension API
 * contract. `entryPoints` are async factories returning a `{ register }` module;
 * this shape enables a future P2 dynamic-import loader without an API-version
 * bump.
 */
export interface HapiExtensionManifest {
  id: string;
  version: string;
  apiVersion: string;
  displayName: string;
  description: string;
  defaultEnabled: boolean;
  dependsOn?: readonly string[];
  conflictsWith?: readonly string[];
  requiredAtBuild?: boolean;
  /**
   * Privileged host-facade capabilities this extension requires (issue #1291,
   * ADR-0003). DEFAULT-DENY: the per-runtime host gates every privileged API
   * (raw DB, secrets, core internals, route mounting, UI/CLI contribution points)
   * against this set and throws `CapabilityDeniedError` on an undeclared call.
   * Ambient surfaces (own `config.get`, the event bus, `log`, `services`,
   * lifecycle) are never gated. Omitted / empty ⇒ no privileged capability.
   * Additive + optional — the pre-stable v0.1 API needs no version bump to add it.
   */
  capabilities?: readonly Capability[];
  /**
   * Capability-catalog entries contributed DECLARATIVELY (issue #3752). A
   * filesystem extension declares these under the `manifest.json` top-level
   * `catalog: [...]` key (validated at load by `FsExtensionManifestSchema` — a
   * `<script>`/`<`/`>` in any text field, a bad id prefix, or a missing
   * `availability.scope` fails the whole extension's load). The loader stamps
   * `owner = id` and `trusted` from provenance at its drain, then merges them into
   * the live Tier-1 catalog as `runtime-only` entries. This is a DISTINCT key from
   * {@link capabilities} (privilege strings) — catalog entries are NEVER nested
   * under `capabilities`, which would collide with the privilege array. Optional;
   * build-composed extensions normally contribute via `host.capabilities.add`.
   */
  catalog?: readonly CatalogEntry[];
  configSchema?: z.ZodTypeAny;
  entryPoints: {
    server?: () => Promise<{ register: ServerRegister }>;
    web?: () => Promise<{ register: WebRegister }>;
    cli?: () => Promise<{ register: CliRegister }>;
  };
}

/**
 * Extracts the parsed config type of a manifest's `configSchema`, or `never`
 * when the manifest declares no config schema.
 */
export type InferExtensionConfig<TManifest extends HapiExtensionManifest> =
  TManifest["configSchema"] extends z.ZodTypeAny
    ? z.infer<TManifest["configSchema"]>
    : never;

/**
 * Parse `input` against `schema`, returning the typed result. Throws a
 * `ZodError` on failure (fast-fail use case — the loader validates an
 * extension's config blob against its manifest `configSchema`).
 */
export function validateExtensionConfig<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown
): z.infer<TSchema> {
  return schema.parse(input);
}

/**
 * Safe-parse `input` against `schema`, returning a discriminated result
 * (`{ success: true, data }` or `{ success: false, error }`) instead of throwing
 * (handle-error use case).
 */
export function safeValidateExtensionConfig<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown
): z.ZodSafeParseResult<z.infer<TSchema>> {
  return schema.safeParse(input);
}

/**
 * A runtime an extension can declare an entry point for. Mirrors the keys of
 * `HapiExtensionManifest.entryPoints`.
 */
export type ExtensionRuntime = "server" | "web" | "cli";

/**
 * Runtime-agnostic metadata for ONE configured extension — the payload of the
 * generated `@hapi/protocol/extensionsMetadata` registry (issue #2329).
 *
 * Why this exists: each package's `extensions.generated.ts` carries only the
 * extensions declaring THAT runtime's entry point, so no single package can
 * enumerate the whole set. `GET /api/extension-prefs` is built from the SERVER
 * registry, which is why its payload omits web-only (`builtin.analytics`,
 * `builtin.error-log-viewer`, `builtin.tool-views`) and CLI-only
 * (`builtin.agent-codex`, `builtin.agent-gemini`) extensions, and carries no
 * `requiredAtBuild` flag. A control-plane UI needs all of it — and because the
 * server package depends only on `@hapi/protocol`, `shared/` is the only place
 * all three runtimes' metadata can legally live.
 *
 * Emitted as INLINED LITERALS (never manifest imports), so this module pulls no
 * `entryPoints` thunks — and therefore no extension code — into any consumer's
 * module graph. Same concern as the `@/ext/host` vs `@/ext/lifecycle` import
 * boundary (#1268).
 *
 * `requiredAtBuild` is NORMALIZED to a boolean here (the manifest field is
 * optional; an absent value means `false`).
 */
export interface ExtensionMetadata {
  id: string;
  displayName: string;
  description: string;
  version: string;
  defaultEnabled: boolean;
  /** Normalized from the optional manifest field — absent ⇒ `false`. */
  requiredAtBuild: boolean;
  /**
   * Every runtime this extension declares an entry point for, ascending. A
   * dual-half extension (e.g. `builtin.git-rpc`) ships as two directories
   * sharing one id, so codegen UNIONS their `entryPoints` keys here.
   */
  runtimes: readonly ExtensionRuntime[];
}

/**
 * One entry of the `GET /api/extension-registry` payload (issue #2329) —
 * {@link ExtensionMetadata} plus the resolved runtime state.
 *
 * `enabled` is the EFFECTIVE state, not the raw row: for a `requiredAtBuild`
 * extension every loader short-circuits its enable check, so this is reported
 * `true` regardless of any persisted row. Reporting the row value there would
 * render a lie in the UI (an extension shown "off" that is in fact loaded).
 *
 * `hasExplicitPref` distinguishes "the user set this" from "this is the manifest
 * default", so a revert-to-default affordance can be added later without a
 * schema change.
 */
export interface ExtensionSummary extends ExtensionMetadata {
  enabled: boolean;
  hasExplicitPref: boolean;
  /**
   * The PROBED installed-binary version of a CLI-harness extension (issue #3313,
   * epic #3345). Resolved at request time from the #1769 harness-detection store
   * (`store.harness.getDetectionState(nodeId, harnessId)?.installed_version`),
   * NOT from the manifest — so a CLI entry can show the real installed version
   * (e.g. `builtin.agent-codex` → `0.147.0`) instead of the wrapper manifest
   * `version` (`0.1.0`). `null` when the extension has no harness descriptor
   * (every non-CLI extension, and catalog CLIs that get no descriptor) or when
   * detection has not (yet) succeeded — the render layer shows an honest
   * "unprobed" fallback there and NEVER promotes the wrapper `version` to the
   * primary slot. The existing `version` field is UNCHANGED: it stays the
   * wrapper manifest version, demoted to a detail line at the render layer.
   *
   * Additive + optional — the pre-stable v0.1 extension API adds fields without
   * a version bump (see the header note above), so older clients ignore it.
   */
  probedVersion?: string | null;
}
