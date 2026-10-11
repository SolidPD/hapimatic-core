// SPDX-License-Identifier: AGPL-3.0-only
/**
 * About-page host-info + harness-enumeration gatherer (issue #1984, epic #1981).
 *
 * Sibling of `systemHealth.ts` — same module shape (a single async `gather*`
 * composer over small defensive collectors, each of which try/catch-returns
 * `null`/`false` rather than throwing, so one failing collector degrades the
 * field instead of the whole endpoint — R7). Where `systemHealth` gathers LIVE
 * metrics (CPU/RAM/disk usage), this gathers STATIC host identity + the harness
 * enumeration for the Admin Drawer About page.
 *
 * The payload conforms to `AboutInfoSchema` (`@hapi/protocol`) — the B2↔B3
 * contract. Sensitive-field hazard (R4): the Tailscale tailnet OWNER identity
 * (`CurrentTailnet.Name`, an account email) is NEVER read.
 */
import * as os from "node:os";
import * as fs from "node:fs";
import {
  HarnessInfoSchema,
  type AboutInfo,
  type HarnessInfo,
  type TailscaleInfo,
} from "@hapi/protocol";

// Single-sourced from the schema enum so the gatherer can never emit a flavor
// the schema would reject. Mirrors `KNOWN_AGENTS`
// (`cli/src/utils/agentCapabilities.ts`) / `AgentFlavor` (`shared/src/modes.ts`).
const HARNESS_FLAVORS = HarnessInfoSchema.shape.flavor.options;

// Bounds for the two external-command probes. There is NO in-repo precedent for
// a spawn timeout (`getDiskUsage` has none), but `await new Response(...).text()`
// alone can hang on a wedged CLI — so both probes use Bun.spawn's native timeout.
// 3000ms captures node-launched CLIs whose cold start runs ~2.2s (measured:
// `opencode --version` on a Pi 5 → 2.24s), and matches the tailscale bound so
// the endpoint's concurrent-probe worst case stays ~3s (probes run in parallel
// and the result is cached for the process lifetime — only the first call pays).
const HARNESS_VERSION_TIMEOUT_MS = 3000;
const TAILSCALE_TIMEOUT_MS = 3000;

// Harness versions are stable for a process's lifetime (like
// `detectAgentCapabilities()`'s cache). B2 polls `/api/about`, so caching avoids
// re-spawning up to 4 `--version` subprocesses per request (expert-review D2 —
// upgraded from optional to recommended).
let cachedHarnesses: HarnessInfo[] | null = null;

/**
 * Friendly OS name: `PRETTY_NAME` from `/etc/os-release`, falling back to
 * `os.type()` on non-Linux or a read failure.
 */
function getOsName(): string {
  try {
    const content = fs.readFileSync("/etc/os-release", "utf-8");
    for (const line of content.split("\n")) {
      if (line.startsWith("PRETTY_NAME=")) {
        return line.slice("PRETTY_NAME=".length).replace(/^"|"$/g, "").trim();
      }
    }
  } catch {
    // /etc/os-release absent or unreadable — fall through to os.type().
  }
  return os.type();
}

/**
 * Device model from `/proc/device-tree/model` (Raspberry Pi + many ARM SBCs).
 * Strips the trailing NUL the device-tree node carries. `null` on non-Pi
 * hardware where the node is absent (R7).
 */
function getDeviceModel(): string | null {
  try {
    const raw = fs.readFileSync("/proc/device-tree/model", "utf-8");
    const cleaned = raw.replace(/\0/g, "").trim();
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

/**
 * Detect a single harness's version via a bounded `<flavor> --version` spawn.
 * Captures the raw first non-empty stdout line (the four CLIs format `--version`
 * differently — capturing raw is robust; do NOT over-parse). `null` on spawn
 * failure or timeout (R7 / OR-2).
 */
async function detectHarnessVersion(flavor: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([flavor, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: HARNESS_VERSION_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const firstLine = output
      .split("\n")
      .map(l => l.trim())
      .find(l => l.length > 0);
    return firstLine ?? null;
  } catch {
    return null;
  }
}

/**
 * Enumerate the launchable harnesses (agent flavors) with availability +
 * detected version. Availability is a `Bun.which` PATH lookup (no spawn — same
 * idiom as `detectAgentCapabilities()`); a version probe runs only for available
 * flavors. All flavors are probed concurrently. Cached for the process lifetime.
 */
async function gatherHarnesses(): Promise<HarnessInfo[]> {
  if (cachedHarnesses) return cachedHarnesses;
  const harnesses = await Promise.all(
    HARNESS_FLAVORS.map(async (flavor): Promise<HarnessInfo> => {
      const available =
        typeof Bun !== "undefined" && Boolean(Bun.which(flavor));
      const version = available ? await detectHarnessVersion(flavor) : null;
      return { flavor, available, version };
    })
  );
  cachedHarnesses = harnesses;
  return harnesses;
}

/**
 * Non-sensitive Tailscale identity via `tailscale status --json`. Reads ONLY
 * `Self.DNSName` (MagicDNS hostname), the top-level `MagicDNSSuffix`, and the
 * first IPv4 in `Self.TailscaleIPs`. NEVER reads `CurrentTailnet.Name` (the
 * tailnet owner's email — R4). `null` when tailscale is absent / not running
 * / output unparseable (R7 / OR-4).
 */
async function gatherTailscale(): Promise<TailscaleInfo> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: TAILSCALE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    const parsed = JSON.parse(output) as {
      Self?: { DNSName?: unknown; TailscaleIPs?: unknown };
      MagicDNSSuffix?: unknown;
    };
    const self = parsed.Self ?? {};

    const hostname =
      typeof self.DNSName === "string"
        ? self.DNSName.replace(/\.$/, "") || null
        : null;
    const tailnetSuffix =
      typeof parsed.MagicDNSSuffix === "string" ? parsed.MagicDNSSuffix : null;
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
    const ipv4 =
      ips.find(
        (ip): ip is string => typeof ip === "string" && ip.includes(".")
      ) ?? null;

    return { hostname, tailnetSuffix, ipv4 };
  } catch {
    return null;
  }
}

/**
 * Compose the full About payload. Static host facts are synchronous; the two
 * external-command groups (harnesses, tailscale) run concurrently. A single
 * failing collector degrades to `null`/`false` — never throws (R7).
 *
 * `opts.backupKeyEligible` (#3119) is the only externally-supplied input — the
 * caller (the local `/about` route) threads in `configuration.googleOAuthEnabled`
 * so this stays a PURE function (no env/config read, no side effects at request
 * time). Defaults to `false`, so the bare federation call site
 * (`routes/federation/infrastructure.ts`, ruling D3(A)) compiles unchanged and a
 * proxied remote About reports `false`.
 */
export async function gatherAboutInfo(opts?: {
  backupKeyEligible?: boolean;
}): Promise<AboutInfo> {
  const [harnesses, tailscale] = await Promise.all([
    gatherHarnesses(),
    gatherTailscale(),
  ]);

  return {
    os: {
      name: getOsName(),
      kernel: os.release(),
      arch: os.arch(),
    },
    hardware: {
      deviceModel: getDeviceModel(),
      cpuCores: os.cpus().length,
      totalRamBytes: os.totalmem(),
    },
    uptime: {
      serverProcessSec: Math.floor(process.uptime()),
      systemSec: Math.floor(os.uptime()),
    },
    tailscale,
    harnesses,
    timestamp: Date.now(),
    // No build stamp exposes a git SHA (version.generated.ts carries only
    // VERSION + VERSION_TIMESTAMP) and we NEVER spawn git at request time (R7);
    // `null` closes #1983 O4 (B2 renders "—").
    commit: null,
    // #3119: gateway-managed cloud VM ⇒ backup-key custody eligible. Threaded
    // in by the local /about route from configuration.googleOAuthEnabled;
    // defaults false (physical node / bare federation call).
    backupKeyEligible: opts?.backupKeyEligible ?? false,
  };
}

/**
 * Reset the harness cache. Exported for tests only — runtime callers never need
 * it (harness availability/versions are stable across the process lifetime).
 */
export function _resetHarnessCache(): void {
  cachedHarnesses = null;
}
