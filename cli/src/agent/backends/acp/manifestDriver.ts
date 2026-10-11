// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Generic ACP egress driver — the two-tier config resolver (issue #3127, Task 2).
 *
 * `AcpSdkBackend` is ALREADY generic ACP infrastructure (its constructor is
 * fully config-driven). What was missing is a declarative way to describe an
 * ACP-capable CLI so that adding one needs only config + a spawn command — no
 * new backend code (AC). This module is that layer: `resolveAcpConfig` turns a
 * declarative source into concrete backend inputs, and the CLOSED quirk
 * vocabulary makes ACP-dialect differences DATA (a zod enum with one interpreter
 * each) rather than per-CLI code.
 *
 * TWO-TIER SOURCING (KD2 / epic ruling D8b). The config a CLI needs (spawn
 * command/args, ACP client capabilities, dialect quirks) is contributed by the
 * EXTENSION layer — stock CLIs at extension registration (the agent-gemini
 * pattern), catalog CLIs (Cursor/Cline/Kimi) via #3120's contribution surface.
 * The stock manifest `acp` tri-state axis (#3118, `shared/src/harnessManifest.ts`)
 * is ONLY the capability GATE: a CLI whose `acp.server` is `"absent"` has no ACP
 * server for Hapimatic to drive, so it routes to the headless fallback binding
 * (`headlessFallbackBinding.ts`), NEVER through this resolver. This module
 * deliberately does NOT read or widen `HarnessManifest` — doing so would re-open
 * epic decision D8 (OR5).
 */
import { z } from "zod";
import {
  DEFAULT_ACP_CLIENT_CAPABILITIES,
  type AcpClientCapabilities,
} from "./AcpSdkBackend";

/**
 * Zod mirror of {@link AcpClientCapabilities} (`AcpSdkBackend.ts`). Kept here so
 * a contributed source can be validated at the resolve boundary; the TS type
 * remains the single shape both packages agree on.
 */
export const acpClientCapabilitiesSchema = z.object({
  fs: z.object({
    readTextFile: z.boolean(),
    writeTextFile: z.boolean(),
  }),
  terminal: z.boolean(),
});

/**
 * The CLOSED ACP-dialect quirk vocabulary (R6 / KD7). Every id has EXACTLY ONE
 * documented interpreter in the driver (`AcpSdkBackend`); an unknown id is a
 * typed error at resolve time — this is a zod enum, never an open passthrough
 * bag. A NEW dialect dimension is a schema change PLUS its interpreter landed
 * together, never silent data drift.
 *
 * - `auth-negotiation` — when the `initialize` response advertises a non-empty
 *   `authMethods` array, send an ACP `authenticate` request (methodId = the
 *   first advertised method) before the first `session/new`. Interpreter:
 *   `AcpSdkBackend.initialize()`. ABSENT (the default) → the backend ignores
 *   `authMethods` exactly as it does today, so gemini/opencode stay
 *   byte-identical. This is the dimension Cursor's `agent acp` most plausibly
 *   exercises (the backend ignores `authMethods` today); its exact request shape
 *   follows the ACP spec and must be verified against the installed Cursor
 *   binary before Cursor's manifest declares it (see Task 7).
 */
export const acpQuirkIdSchema = z.enum(["auth-negotiation"]);
export type AcpQuirkId = z.infer<typeof acpQuirkIdSchema>;

/**
 * A declarative ACP config source an extension contributes. `command`/`args`
 * are the spawn command; `clientCapabilities` opts into fs/terminal (omitted →
 * the text-only default); `quirks` are validated against the CLOSED vocabulary.
 * Environment is NOT part of the source — it is layered at the call site (full
 * process-env passthrough), so the resolver stays env-agnostic.
 */
export const acpConfigSourceSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  clientCapabilities: acpClientCapabilitiesSchema.optional(),
  quirks: z.array(acpQuirkIdSchema).optional(),
});
export type AcpConfigSource = z.infer<typeof acpConfigSourceSchema>;

/**
 * Fully-resolved backend inputs (defaults applied). Consumed by
 * `createAcpBackend` (`AcpSdkBackend.ts`) together with a call-site `env`.
 */
export interface ResolvedAcpConfig {
  command: string;
  args: string[];
  clientCapabilities: AcpClientCapabilities;
  quirks: AcpQuirkId[];
}

/**
 * Resolve a declarative ACP source into concrete backend inputs. THROWS a
 * `ZodError` on an unknown quirk id (R6 — a typed error at resolve time) or a
 * malformed source. Defaults: missing `args` → `[]`; missing `clientCapabilities`
 * → the text-only default (gemini-compatible — its resolved config is the
 * byte-identical regression oracle); missing `quirks` → `[]` (byte-identical
 * handshake).
 */
export function resolveAcpConfig(source: unknown): ResolvedAcpConfig {
  const parsed = acpConfigSourceSchema.parse(source);
  return {
    command: parsed.command,
    args: parsed.args ?? [],
    clientCapabilities:
      parsed.clientCapabilities ?? DEFAULT_ACP_CLIENT_CAPABILITIES,
    quirks: parsed.quirks ?? [],
  };
}
