// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stock-4 baked presence + pinned-version assertion (issue #3120, Task 4/R4).
 *
 * The stock 4 (`claude`, `codex`, `gemini`, `opencode`) are baked at provision/deploy time
 * (ruling D2) rather than lazy-installed from the catalog. This asserts, at provision/deploy,
 * that each stock binary is PRESENT and — when the provisioner supplies a pinned version —
 * that its installed version MATCHES, failing LOUD on a missing or mismatched binary.
 *
 * No second version store (R2): the stock-4 LIST comes from `KNOWN_AGENT_IDS` (#3118), the
 * PRESENCE check reuses `Bun.which` (same as `cli/src/utils/agentCapabilities.ts`), and the
 * VERSION probe reuses the {@link HarnessUpdateRegistry} port's `probe` (which mirrors #1769's
 * detection contract). The pinned versions are a PARAMETER supplied by the provisioner — this
 * module hardcodes no stock-4 version constant.
 */
import { KNOWN_AGENT_IDS } from "@hapi/protocol";
import {
  createHarnessUpdateRegistry,
  type CommandRunner,
} from "@/ext/harnessUpdateRegistry";

/** Semver extraction used for every stock probe (mirrors #1769's claude `version_regex`). */
const STOCK_VERSION_REGEX = "(\\d+\\.\\d+\\.\\d+)";

export interface StockAssertionOptions {
  /**
   * Pinned version per stock agent id (e.g. `{ claude: "2.1.207" }`). When a pinned version
   * is provided for an agent, its INSTALLED version must match exactly; agents without a
   * pinned entry are presence-only.
   */
  pinnedVersions?: Partial<Record<string, string>>;
  /** Presence check (defaults to `Bun.which`). Injectable for tests. */
  which?: (bin: string) => string | null;
  /** Version-probe subprocess runner (defaults to `spawnSync`). Injectable for tests. */
  run?: CommandRunner;
}

/** Per-agent outcome of the stock assertion. */
export interface StockAgentResult {
  id: string;
  present: boolean;
  version: string | null;
  pinned?: string;
  match: boolean;
}

export interface StockAssertionResult {
  ok: boolean;
  results: StockAgentResult[];
}

/** Thrown when one or more stock harnesses are missing or version-mismatched (fails loud). */
export class StockHarnessAssertionError extends Error {
  readonly failures: string[];
  constructor(failures: string[]) {
    super(`Stock harness assertion FAILED:\n  - ${failures.join("\n  - ")}`);
    this.name = "StockHarnessAssertionError";
    this.failures = failures;
  }
}

/**
 * Assert the stock 4 are present (and, where pinned, version-matched). Throws
 * {@link StockHarnessAssertionError} on any missing/mismatched binary; returns the per-agent
 * result on success.
 */
export async function assertStockHarnesses(
  opts: StockAssertionOptions = {}
): Promise<StockAssertionResult> {
  const which =
    opts.which ??
    ((bin: string): string | null =>
      typeof Bun !== "undefined" ? Bun.which(bin) : null);
  const registry = createHarnessUpdateRegistry(opts.run);

  const results: StockAgentResult[] = [];
  const failures: string[] = [];

  for (const id of KNOWN_AGENT_IDS) {
    const present = which(id) !== null;
    const pinned = opts.pinnedVersions?.[id];
    if (!present) {
      failures.push(
        `stock harness '${id}' is not installed (Bun.which found no binary)`
      );
      results.push({ id, present: false, version: null, pinned, match: false });
      continue;
    }
    if (pinned === undefined) {
      // Presence-only: no pinned version supplied for this agent.
      results.push({ id, present: true, version: null, match: true });
      continue;
    }
    const version = await registry.probe({
      cmd: `${id} --version`,
      versionRegex: STOCK_VERSION_REGEX,
    });
    const match = version !== null && version === pinned;
    if (!match) {
      failures.push(
        `stock harness '${id}' version '${version ?? "unknown"}' does not match pinned '${pinned}'`
      );
    }
    results.push({ id, present: true, version, pinned, match });
  }

  if (failures.length > 0) {
    throw new StockHarnessAssertionError(failures);
  }
  return { ok: true, results };
}

/**
 * Read pinned stock versions from the `HAPI_STOCK_PINNED_VERSIONS` env var (a JSON object like
 * `{"claude":"2.1.207"}`). Absent / malformed → `undefined` (presence-only assertion). This is
 * how the provisioner supplies what it pinned without a hardcoded store.
 */
export function readPinnedStockVersionsFromEnv():
  | Record<string, string>
  | undefined {
  const raw = process.env.HAPI_STOCK_PINNED_VERSIONS;
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object")
      return parsed as Record<string, string>;
  } catch {
    // fall through — malformed env is treated as "no pins" (presence-only)
  }
  return undefined;
}
