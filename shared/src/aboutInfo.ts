// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// About-page host-info + harness-enumeration contract (issue #1984, epic #1981).
//
// This is the single typed contract shared between B3 (the `/api/about` server
// endpoint that produces the payload) and B2 (#1983, the Admin Drawer About UI
// that consumes it). Keep field names in lockstep with what B2 renders — this
// schema IS the B2↔B3 coordination boundary.
//
// Scope split (B3 KD-3): B3 supplies STATIC host identity + harnesses +
// tailscale + uptime. LIVE metrics (CPU temp / RAM% / disk%) stay with the
// already-shipped `GET /api/system-health`; node/role/peers with
// `GET /federation/info`.

// ─── Harness enumeration ─────────────────────────────────────

// A "harness" is a distinct launchable AGENT FLAVOR (agent CLI) — NOT a
// launcher mode. The flavor set mirrors `AgentFlavor` (`shared/src/modes.ts`)
// and `KNOWN_AGENTS` (`cli/src/utils/agentCapabilities.ts`). The Claude-only
// launcher kinds (`sdk`/`pty`/`tmux`) are spawn modes of the one `claude`
// binary and are surfaced separately by `GET /api/launcher/status` — they are
// deliberately NOT harnesses. See the harness decision on epic #1981.
export const HarnessInfoSchema = z.object({
  flavor: z.enum(["claude", "codex", "gemini", "opencode"]),
  available: z.boolean(), // binary present on PATH (Bun.which)
  version: z.string().nullable(), // raw first `--version` stdout line; null if absent/timed-out
});
export type HarnessInfo = z.infer<typeof HarnessInfoSchema>;

// ─── Tailscale identity ──────────────────────────────────────

// Non-sensitive Tailscale identity. Deliberately has NO field for the tailnet
// OWNER (`CurrentTailnet.Name`, which is the account email — R4). The whole
// object is nullable so a node without tailscale reports `null`.
export const TailscaleInfoSchema = z
  .object({
    hostname: z.string().nullable(), // MagicDNS name (Self.DNSName, trailing dot stripped)
    tailnetSuffix: z.string().nullable(), // MagicDNSSuffix, e.g. "example.ts.net"
    ipv4: z.string().nullable(), // first IPv4 in Self.TailscaleIPs, e.g. "100.x.y.z"
  })
  .nullable();
export type TailscaleInfo = z.infer<typeof TailscaleInfoSchema>;

// ─── About payload ───────────────────────────────────────────

// Full `/api/about` response. `.passthrough()` on the outer object tolerates
// forward-compatible field additions from a newer peer (matches the
// `@hapi/protocol` forked-data convention — see `shared/CLAUDE.md`).
export const AboutInfoSchema = z
  .object({
    os: z.object({
      name: z.string(), // friendly OS name (/etc/os-release PRETTY_NAME, else os.type())
      kernel: z.string(), // os.release()
      arch: z.string(), // os.arch()
    }),
    hardware: z.object({
      deviceModel: z.string().nullable(), // /proc/device-tree/model; null on non-Pi
      cpuCores: z.number().int(), // os.cpus().length
      totalRamBytes: z.number(), // os.totalmem()
    }),
    uptime: z.object({
      serverProcessSec: z.number(), // process.uptime() — THIS instance's uptime (B2 Instance row)
      systemSec: z.number(), // os.uptime() — seconds since system boot
    }),
    tailscale: TailscaleInfoSchema,
    harnesses: z.array(HarnessInfoSchema),
    timestamp: z.number(), // Date.now() at gather time
    commit: z.string().nullable(), // app build SHA if a build stamp exposes one, else null (closes #1983 O4)
    // #3119: true when this instance is a gateway-managed cloud VM (the Google
    // handoff secret is present ⇒ backup-key custody eligible), false on a
    // self-hosted physical node. Drives the Settings backup-key indicator
    // (DETECT-and-HIDE: the row renders only when eligible). An older peer's
    // About payload may omit this field, so UI consumers branch on `=== true`
    // (undefined ⇒ treated as not eligible ⇒ hidden).
    backupKeyEligible: z.boolean(),
  })
  .passthrough();
export type AboutInfo = z.infer<typeof AboutInfoSchema>;
