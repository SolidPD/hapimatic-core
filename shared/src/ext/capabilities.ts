// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extension capability taxonomy + enforcement primitives (issue #1291, epic #1264).
 *
 * The capability model is the HOST-FACADE ACCESS GATE for the extension system —
 * the security boundary chosen in
 * [`docs/internal/decisions/adr-0003-extension-sandboxing.md`](../../../docs/internal/decisions/adr-0003-extension-sandboxing.md).
 * An extension declares the capabilities it needs in its manifest
 * (`HapiExtensionManifest.capabilities`, or `manifest.json` `capabilities` for a
 * filesystem extension); each per-runtime host facade checks a call against the
 * declared set before granting a PRIVILEGED API, throwing
 * {@link CapabilityDeniedError} otherwise. Capabilities are DEFAULT-DENY: an
 * undeclared capability is unavailable.
 *
 * This model is INTENTIONALLY INDEPENDENT of the isolation model (ADR-0003 §Decision.2):
 * v0.1 runs extensions in-process (no OS isolation), so the capability gate is the
 * whole security boundary at this stage. Because the facade is the single
 * enforcement point, a future isolation upgrade (separate-process / iframe) is
 * additive and does not change the extension contract
 * (`manifest.capabilities` + `register(host)`).
 *
 * Ambient (always-allowed, NON-privileged) surfaces are deliberately NOT
 * capabilities: an extension's OWN `config.get()`, the server extension event bus
 * (`events.subscribe/emit`), `log`, the cross-extension `services` registry,
 * lifecycle hooks, and `getJobNodeId()`. Only the privileged surface enumerated in
 * {@link CAPABILITIES} is gated.
 *
 * Kept zod-only (NO node/server/web imports) because `@hapi/protocol/ext` is
 * imported by the browser bundle.
 */
import { z } from "zod";

/**
 * The privileged capability taxonomy (v0.1). Each value gates one or more real
 * host-facade methods. The high-risk escalation vectors — `store.raw`,
 * `secrets.federationToken`, `core.config`, `core.internals` — are the accessors
 * that reach past an extension's own sandboxed surface (raw DB, live secrets,
 * core services). The `docs/extensions/authoring.md` §"Security model" table is
 * the canonical `capability → host method` map.
 */
export const CAPABILITIES = [
  // ── server ──
  /** `ServerExtensionHost.notifications.addChannel` */
  "notifications",
  /** `{Server,Cli}ExtensionHost.agents.register` */
  "agents",
  /** `ServerExtensionHost.routes.add` — mounts authenticated `/api` routes. */
  "http.routes",
  /** `ServerExtensionHost.store.addTable` / `addMigration` (already `ext_<id>_`-prefixed). */
  "store",
  /** `ServerExtensionHost.getRawDb()` — raw `bun:sqlite`, BYPASSES the `ext_<id>_` prefix (HIGH). */
  "store.raw",
  /** `ServerExtensionHost.getFederationApiToken()` — returns a live secret (HIGH). */
  "secrets.federationToken",
  /** `ServerExtensionHost.getCoreConfig()` — exposes `telegramBotToken` / JWT config (HIGH). */
  "core.config",
  /** `ServerExtensionHost.getSyncEngine`/`getStore`/`getRpcRegistry`/… core services (MED-HIGH). */
  "core.internals",
  /** `ServerExtensionHost.capabilities.add` — contribute a capability-catalog entry (#3752, ADR-0003 host-facade gate). */
  "catalog.contribute",
  // ── cli ──
  /** `CliExtensionHost.commands.add` */
  "cli.commands",
  /** `CliExtensionHost.harness.register` — contributes a catalog CLI harness (#3120). */
  "harness",
  // ── web ──
  /** `WebExtensionHost.toolViews.add{Compact,FullInput,Result}` */
  "ui.toolViews",
  /** `WebExtensionHost.sessionDetail.add{Tab,InfoField,Action}` */
  "ui.sessionDetail",
  /** `WebExtensionHost.preferences.addSection` */
  "ui.preferences",
  /** `WebExtensionHost.navigation.addRoute` */
  "ui.navigation",
] as const;

/** A declared extension capability — one of {@link CAPABILITIES}. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Zod enum over {@link CAPABILITIES}. Used to validate a filesystem extension's
 * `manifest.json` `capabilities` array (`shared/src/ext/fsManifest.ts`) and any
 * runtime-supplied capability list.
 */
export const CapabilitySchema = z.enum(CAPABILITIES);

/** Set form of {@link CAPABILITIES} for O(1) membership checks. */
const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

/** True iff `value` is a known {@link Capability}. */
export function isCapability(value: string): value is Capability {
  return CAPABILITY_SET.has(value);
}

/**
 * Thrown by a host facade when an extension calls a PRIVILEGED API without
 * declaring the gating capability. Carries the offending `extensionId`, the
 * `capability` that was required, and the `method` that was denied so the loader's
 * fail-soft path (a throwing `register` is logged + skipped) and the negative
 * tests (AC #3) can assert precisely which gate fired.
 */
export class CapabilityDeniedError extends Error {
  readonly extensionId: string;
  readonly capability: Capability;
  readonly method: string;

  constructor(extensionId: string, capability: Capability, method: string) {
    super(
      `[ext:${extensionId}] capability "${capability}" is required for ${method}() ` +
        `but was not declared in the extension manifest's "capabilities" array (default-deny). ` +
        `Add "${capability}" to the manifest's capabilities to grant it.`
    );
    this.name = "CapabilityDeniedError";
    this.extensionId = extensionId;
    this.capability = capability;
    this.method = method;
  }
}

/** Construction options for {@link CapabilityGate}. */
export interface CapabilityGateOptions {
  /**
   * A TRUSTED extension bypasses the gate entirely (every capability granted).
   * This is set by the LOADER from PROVENANCE, never from the manifest — a
   * build-composed extension (compiled into the binary) is trusted; a runtime
   * FILESYSTEM-loaded extension (the untrusted surface `HAPI_FS_EXTENSIONS`
   * enables) is NOT. Keying trust off the load path — not the extension id — is
   * what stops a malicious filesystem extension from self-declaring a trusted
   * id to bypass the gate (ADR-0003 threat model H1 vs H2).
   *
   * Fail-closed default: an unspecified gate is UNTRUSTED, so a caller that
   * forgets to pass provenance gets the safe (gated) behavior.
   */
  trusted?: boolean;
}

/**
 * A per-extension capability checker. The loader builds ONE per extension from its
 * declared `capabilities` + its PROVENANCE (trusted/untrusted), and each host
 * facade uses it to gate privileged methods:
 * - the SERVER host holds a gate in its per-extension deps and calls
 *   {@link CapabilityGate.require} inside each privileged method;
 * - the CLI and WEB filesystem loaders wrap the shared host in a per-extension
 *   proxy that calls {@link CapabilityGate.require} before forwarding a
 *   privileged call.
 *
 * `declared` defaults to empty — DEFAULT-DENY: an untrusted extension that
 * declares no capabilities is granted no privileged capability.
 */
export class CapabilityGate {
  private readonly declared: ReadonlySet<Capability>;
  private readonly trusted: boolean;

  constructor(
    readonly extensionId: string,
    declared: readonly Capability[] = [],
    opts: CapabilityGateOptions = {}
  ) {
    this.declared = new Set(declared);
    this.trusted = opts.trusted ?? false;
  }

  /**
   * True iff this extension may use `capability` — either it is trusted
   * (build-composed) or it declared the capability.
   */
  has(capability: Capability): boolean {
    return this.trusted || this.declared.has(capability);
  }

  /**
   * Throw {@link CapabilityDeniedError} unless {@link CapabilityGate.has} is true.
   * `method` is the host method name surfaced in the error (e.g. `"getRawDb"`).
   * A no-op for trusted (build-composed) extensions.
   */
  require(capability: Capability, method: string): void {
    if (!this.has(capability)) {
      throw new CapabilityDeniedError(this.extensionId, capability, method);
    }
  }
}
