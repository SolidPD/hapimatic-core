// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hapi ext <install|enable|disable|uninstall|list|update>` — extension lifecycle
 * CLI commands (issue #1290, epic #1264 Phase 5).
 *
 * The user-facing surface for the runtime filesystem extension system (#1289). Modeled
 * on `cli/src/commands/launcher.ts`: per-subcommand `run*` handlers, `parseFlags`,
 * `--json` envelopes, launcher-style exit codes (usage → 3, instance-coherence → 4),
 * and the #1433 instance-coherence gate on every state-mutating write.
 *
 * The command layer only parses args, prints, and returns exit codes — all filesystem
 * work is delegated to `@/ext/manage` and enable-state to `@/ext/prefs` (the SOLE
 * `extension_prefs` store). Enablement changes take effect on the next restart (there
 * is no live teardown in P1 — arch-doc semantic).
 */
import { createInterface } from "node:readline/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import { configuration } from "@/configuration";
import { instanceCoherenceCheck } from "./launcher";
import { RegistryError } from "@hapi/protocol/ext";
import {
  installExtension,
  listInstalledExtensions,
  uninstallExtension,
  updateExtensions,
  ExtensionAlreadyInstalledError,
  ExtensionNotInstalledError,
  RegistryIntegrityError,
} from "@/ext/manage";
import {
  setCliExtensionPref,
  ExtensionPrefsStoreUnavailableError,
} from "@/ext/prefs";
import {
  listCatalogHarnesses,
  resolveCatalogContribution,
} from "@/ext/catalogHarnessRegistry";
import {
  executeRecipeInstall,
  probeRecipeVersion,
  uninstallRecipe,
} from "@/ext/harnessInstall";
import {
  assertScanPass,
  getScanBeforeInstall,
  ScanBlockedError,
  setScanBeforeInstall,
} from "@/ext/scanGate";
import { makeSupplyChainScanner } from "@/ext/supplyChainScan/scanner";
import {
  getScanVerdict,
  recordScanOverride,
  recordScanVerdict,
} from "@/ext/supplyChainScan/verdictStore";
import {
  assertStockHarnesses,
  readPinnedStockVersionsFromEnv,
  StockHarnessAssertionError,
} from "@/ext/stockHarnessAssertion";
import type { HarnessInstallRecipe, ScanBeforeInstall } from "@hapi/protocol";
import type { CommandDefinition } from "./types";

interface ParsedFlags {
  json: boolean;
  force: boolean;
  yes: boolean;
  purge: boolean;
  dryRun: boolean;
  /** #3131: bypass a supply-chain scan BLOCK for THIS artifact (requires overrideReason). */
  overrideScan: boolean;
  /** #3131: the operator's reason for the override (R4 audit "why"). */
  overrideReason?: string;
}

/**
 * Extract the `--override-reason=<why>` / `--override-reason <why>` value (#3131 R4 audit
 * "why"). The `=` form is unambiguous and recommended; the space form is also accepted.
 */
function parseOverrideReason(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--override-reason=")) {
      return a.slice("--override-reason=".length) || undefined;
    }
    if (a === "--override-reason") return args[i + 1];
  }
  return undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  return {
    json: args.includes("--json") || args.includes("-j"),
    force: args.includes("--force") || args.includes("-f"),
    yes: args.includes("--yes") || args.includes("-y"),
    purge: args.includes("--purge"),
    dryRun: args.includes("--dry-run"),
    overrideScan: args.includes("--override-scan"),
    overrideReason: parseOverrideReason(args),
  };
}

/** First non-flag positional argument (the `<id>` / `<source>` operand). */
function firstOperand(args: string[]): string | undefined {
  return args.find(a => !a.startsWith("-"));
}

/** The instance-scoped extensions directory: `${HAPI_HOME}/extensions`. */
function extensionsDir(): string {
  return join(configuration.happyHomeDir, "extensions");
}

/** Emit either a JSON envelope or a human line, matching launcher's dual output. */
function emit(
  flags: ParsedFlags,
  human: string,
  json: Record<string, unknown>
): void {
  if (flags.json) {
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(human);
  }
}

function emitError(
  flags: ParsedFlags,
  message: string,
  code: string,
  extra?: Record<string, unknown>
): void {
  if (flags.json) {
    console.log(
      JSON.stringify({ ok: false, error: message, code, ...extra }, null, 2)
    );
  } else {
    console.error(`Error: ${message}`);
  }
}

// #3131 (Sub Q): fill the pinned #3120 supply-chain scan seam with the real scanner. The
// seam is inert (no-op pass) until this registration; a CLI-side scanner also covers
// web-initiated installs, which shell to `hapi ext install` (the marketplace subprocess).
setScanBeforeInstall(makeSupplyChainScanner());

/** The override actor recorded in the audit trail (#3131 R4 "who"): the host user. */
function scanOverrideActor(): string {
  try {
    return userInfo().username || process.env.USER || "unknown";
  } catch {
    return process.env.USER || "unknown";
  }
}

/**
 * Build the per-invocation supply-chain scan hook (#3131): the registered base scanner
 * (the #3120 seam fill) wrapped with verdict PERSISTENCE (R1) and the per-artifact
 * operator OVERRIDE (R4). The override is per-INVOCATION — one install installs one
 * artifact — so it is inherently per-artifact and NEVER a global bypass. A block WITHOUT
 * `--override-scan` (or without a `--override-reason`) stays blocked (fail-closed).
 */
function installScanHook(flags: ParsedFlags): ScanBeforeInstall {
  const base = getScanBeforeInstall() ?? makeSupplyChainScanner();
  const actor = scanOverrideActor();
  return async staged => {
    const verdict = await base(staged);
    recordScanVerdict(staged.id, verdict);
    if (
      verdict.verdict === "block" &&
      flags.overrideScan &&
      flags.overrideReason
    ) {
      recordScanOverride(staged.id, actor, flags.overrideReason);
      return {
        verdict: "pass",
        findings: [
          ...verdict.findings,
          {
            severity: "info",
            rule: "scan.overridden",
            message: `operator override by ${actor}: ${flags.overrideReason}`,
          },
        ],
      };
    }
    return verdict;
  };
}

/**
 * Instance-coherence gate (#1433) for state-mutating writes. Refuses to write when the
 * invoking binary's suffix disagrees with HAPI_HOME's suffix (HAPI_HOME inherited from
 * another instance), unless `--force`. Returns exit code 4 on refusal, else 0.
 */
function coherenceGate(flags: ParsedFlags, action: string): number {
  const coherence = instanceCoherenceCheck(
    process.execPath,
    configuration.happyHomeDir
  );
  if (coherence.ok || flags.force) return 0;
  const msg =
    `refusing to ${action} — binary suffix '${coherence.binarySuffix}' does not match ` +
    `HAPI_HOME suffix '${coherence.homeSuffix}' (${configuration.happyHomeDir}). ` +
    `HAPI_HOME was likely inherited from another Hapimatic instance. ` +
    `Pin HAPI_HOME explicitly, or re-run with --force.`;
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: "instance_coherence_check_failed",
          action,
          binarySuffix: coherence.binarySuffix,
          homeSuffix: coherence.homeSuffix,
          happyHomeDir: configuration.happyHomeDir,
          forceFlag: "--force",
        },
        null,
        2
      )
    );
  } else {
    console.error(`Error: ${msg}`);
  }
  return 4;
}

/** Interactive yes/no prompt. Non-TTY without `--yes` is refused (never hangs). */
async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${prompt} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Project the stored verdict for an artifact into the `--json` install envelope shape (or
 * `null` when unavailable). One projection site so the two install legs cannot drift
 * (#3131 — a security-verdict transport that must stay identical across install paths).
 */
function scanVerdictEnvelope(artifactId: string) {
  const v = getScanVerdict(artifactId);
  return v
    ? { verdict: v.verdict, findings: v.findings, override: v.override }
    : null;
}

async function runInstall(
  source: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  if (!source) {
    emitError(
      flags,
      "missing source. Usage: hapi ext install <path|url|id|harness-id>",
      "usage"
    );
    return 3;
  }

  // Catalog harness? (resolved by its OPEN id, e.g. `crush`). Route through the recipe
  // rather than the filesystem-extension staging pipeline (#3120).
  const contribution = resolveCatalogContribution(source);
  if (contribution) {
    return runHarnessInstall(source, contribution.installRecipe, flags);
  }

  const gate = coherenceGate(flags, "install");
  if (gate !== 0) return gate;
  if (flags.dryRun) {
    emit(
      flags,
      `[dry-run] would install from '${source}' into ${extensionsDir()}`,
      {
        ok: true,
        action: "install",
        dryRun: true,
        source,
      }
    );
    return 0;
  }
  try {
    // #3120: thread the supply-chain scan hook into the staged pipeline (no-op until #3131).
    const result = await installExtension(source, extensionsDir(), {
      scanBeforeInstall: installScanHook(flags),
    });
    const warningLines = result.warnings.map(w => `  ⚠️  ${w}`).join("\n");
    emit(
      flags,
      `✅ Installed ${result.id} v${result.version}` +
        (warningLines ? `\n${warningLines}` : ""),
      {
        ok: true,
        action: "install",
        id: result.id,
        version: result.version,
        warnings: result.warnings,
        scanVerdict: scanVerdictEnvelope(result.id),
      }
    );
    return 0;
  } catch (err) {
    if (err instanceof ScanBlockedError) {
      // Surface the named findings so the marketplace UI can render the verdict (#3131 R6).
      emitError(flags, err.message, "scan_blocked", {
        verdict: "block",
        findings: err.findings,
      });
      return 1;
    }
    const code =
      err instanceof RegistryIntegrityError
        ? "integrity_failed"
        : err instanceof RegistryError
          ? `registry_${err.reason}`
          : err instanceof ExtensionAlreadyInstalledError
            ? "already_installed"
            : "install_failed";
    emitError(flags, (err as Error).message, code);
    return 1;
  }
}

/**
 * Install a catalog CLI harness via its recipe (#3120). No instance-coherence gate — a
 * harness installs machine-globally (npm -g / brew / a curl binary), NOT into a
 * HAPI_HOME-scoped extensions dir, so instance suffix has no bearing.
 */
async function runHarnessInstall(
  id: string,
  recipe: HarnessInstallRecipe,
  flags: ParsedFlags
): Promise<number> {
  if (flags.dryRun) {
    emit(
      flags,
      `[dry-run] would install harness '${id}' via ${recipe.method}: ${recipe.spec} (pinned ${recipe.pinnedVersion})`,
      {
        ok: true,
        action: "install",
        dryRun: true,
        id,
        method: recipe.method,
        spec: recipe.spec,
        pinnedVersion: recipe.pinnedVersion,
      }
    );
    return 0;
  }
  try {
    // Supply-chain scan (harness-recipe leg) BEFORE executing the recipe (#3120 seam).
    await assertScanPass(installScanHook(flags), {
      kind: "harness-recipe",
      id,
      recipe,
    });
    await executeRecipeInstall(id, recipe);
    emit(
      flags,
      `✅ Installed harness ${id} (${recipe.method}, pinned ${recipe.pinnedVersion})`,
      {
        ok: true,
        action: "install",
        id,
        method: recipe.method,
        pinnedVersion: recipe.pinnedVersion,
        license: recipe.license ?? null,
        scanVerdict: scanVerdictEnvelope(id),
      }
    );
    return 0;
  } catch (err) {
    if (err instanceof ScanBlockedError) {
      emitError(flags, err.message, "scan_blocked", {
        verdict: "block",
        findings: err.findings,
      });
      return 1;
    }
    emitError(flags, (err as Error).message, "harness_install_failed");
    return 1;
  }
}

/**
 * `hapi ext version <harness-id>` (#3120) — probe the INSTALLED version of a catalog CLI
 * harness through the recipe's `versionProbe` (which routes through the HarnessUpdateRegistry
 * port). Reports the installed version + the pinned version, or "not installed".
 */
async function runVersion(
  id: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  if (!id) {
    emitError(
      flags,
      "missing harness id. Usage: hapi ext version <harness-id>",
      "usage"
    );
    return 3;
  }
  const contribution = resolveCatalogContribution(id);
  if (!contribution) {
    emitError(
      flags,
      `'${id}' is not a catalog harness — no version probe available. Run 'hapi ext list' to see catalog harnesses.`,
      "not_catalog_harness"
    );
    return 1;
  }
  const recipe = contribution.installRecipe;
  try {
    const installed = await probeRecipeVersion(recipe);
    if (installed === null) {
      emit(flags, `${id} is not installed (pinned: ${recipe.pinnedVersion})`, {
        ok: true,
        action: "version",
        id,
        installed: false,
        version: null,
        pinnedVersion: recipe.pinnedVersion,
      });
    } else {
      emit(
        flags,
        `${id} ${installed} installed (pinned: ${recipe.pinnedVersion})`,
        {
          ok: true,
          action: "version",
          id,
          installed: true,
          version: installed,
          pinnedVersion: recipe.pinnedVersion,
        }
      );
    }
    return 0;
  } catch (err) {
    emitError(flags, (err as Error).message, "version_failed");
    return 1;
  }
}

/**
 * `hapi ext assert-stock` (#3120, R4) — assert the stock 4 (`claude`,`codex`,`gemini`,
 * `opencode`) are present, and (when `HAPI_STOCK_PINNED_VERSIONS` is set) version-matched.
 * Fails loud (exit 1) on any missing/mismatched binary. Intended for the provision/deploy path.
 */
async function runAssertStock(flags: ParsedFlags): Promise<number> {
  const pinnedVersions = readPinnedStockVersionsFromEnv();
  try {
    const result = await assertStockHarnesses({ pinnedVersions });
    emit(
      flags,
      `✅ Stock harnesses present${pinnedVersions ? " and version-matched" : ""}: ${result.results
        .map(r => r.id)
        .join(", ")}`,
      { ok: true, action: "assert-stock", results: result.results }
    );
    return 0;
  } catch (err) {
    if (err instanceof StockHarnessAssertionError) {
      if (flags.json) {
        console.log(
          JSON.stringify(
            { ok: false, action: "assert-stock", failures: err.failures },
            null,
            2
          )
        );
      } else {
        console.error(`❌ ${err.message}`);
      }
      return 1;
    }
    emitError(flags, (err as Error).message, "assert_stock_failed");
    return 1;
  }
}

/** Friendly display names for the catalog CLIs (ids are short; the UI shows these). */
const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  crush: "Crush",
  cline: "Cline",
  pi: "Pi",
  kimi: "Kimi Code",
  grok: "Grok Build",
  cursor: "Cursor CLI",
};

/**
 * `hapi ext catalog` (#3120) — enumerate the CLI-harness catalog with each entry's recipe
 * metadata (method, pinned version, license, driver binding) and its probed installed version.
 * Consumed by the Extensions-page catalog UI via the marketplace server route (which shells to
 * `hapi ext catalog --json`).
 */
async function runCatalog(flags: ParsedFlags): Promise<number> {
  const entries = await Promise.all(
    listCatalogHarnesses().map(async h => {
      const recipe = h.installRecipe;
      let installedVersion: string | null = null;
      try {
        installedVersion = await probeRecipeVersion(recipe);
      } catch {
        installedVersion = null; // probing is best-effort; a probe failure means "unknown"
      }
      return {
        id: h.id,
        displayName: HARNESS_DISPLAY_NAMES[h.id] ?? h.id,
        method: recipe.method,
        pinnedVersion: recipe.pinnedVersion,
        license: recipe.license ?? null,
        driverBinding: h.driverBinding,
        installed: installedVersion !== null,
        installedVersion,
      };
    })
  );
  entries.sort((a, b) => a.id.localeCompare(b.id));
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, harnesses: entries }, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    console.log("No CLI harnesses in the catalog.");
    return 0;
  }
  for (const e of entries) {
    const state = e.installed
      ? `installed ${e.installedVersion}`
      : "not installed";
    const lic = e.license ? ` [${e.license}]` : "";
    console.log(
      `${e.displayName} (${e.id})  ${e.method}  pinned ${e.pinnedVersion}  ${state}${lic}`
    );
  }
  return 0;
}

function runToggle(
  id: string | undefined,
  enabled: boolean,
  flags: ParsedFlags
): number {
  const action = enabled ? "enable" : "disable";
  if (!id) {
    emitError(
      flags,
      `missing extension id. Usage: hapi ext ${action} <id>`,
      "usage"
    );
    return 3;
  }
  const gate = coherenceGate(flags, action);
  if (gate !== 0) return gate;
  try {
    setCliExtensionPref(id, enabled);
    emit(
      flags,
      `✅ ${id} ${enabled ? "enabled" : "disabled"} (takes effect on restart)`,
      {
        ok: true,
        action,
        id,
        enabled,
        note: "takes effect on restart",
      }
    );
    return 0;
  } catch (err) {
    const code =
      err instanceof ExtensionPrefsStoreUnavailableError
        ? "store_unavailable"
        : `${action}_failed`;
    emitError(flags, (err as Error).message, code);
    return 1;
  }
}

/**
 * Uninstall a catalog CLI harness via its recipe's `uninstall` closure (#3120). Machine-global
 * (npm -g uninstall / brew uninstall / remove the fetched binary) — no coherence gate.
 */
async function runHarnessUninstall(
  id: string,
  recipe: HarnessInstallRecipe,
  flags: ParsedFlags
): Promise<number> {
  if (flags.dryRun) {
    emit(
      flags,
      `[dry-run] would uninstall harness '${id}' (${recipe.method})`,
      {
        ok: true,
        action: "uninstall",
        dryRun: true,
        id,
        method: recipe.method,
      }
    );
    return 0;
  }
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      emitError(
        flags,
        `refusing to uninstall harness '${id}' without confirmation in non-interactive mode — pass --yes`,
        "confirmation_required"
      );
      return 1;
    }
    const ok = await confirm(`Uninstall harness '${id}'?`);
    if (!ok) {
      emit(flags, "Aborted.", {
        ok: true,
        action: "uninstall",
        aborted: true,
        id,
      });
      return 0;
    }
  }
  try {
    await uninstallRecipe(recipe);
    emit(flags, `✅ Uninstalled harness ${id}`, {
      ok: true,
      action: "uninstall",
      id,
      method: recipe.method,
    });
    return 0;
  } catch (err) {
    emitError(flags, (err as Error).message, "harness_uninstall_failed");
    return 1;
  }
}

async function runUninstall(
  id: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  if (!id) {
    emitError(
      flags,
      "missing extension id. Usage: hapi ext uninstall <id> [--purge] [--yes]",
      "usage"
    );
    return 3;
  }

  // Catalog harness? Route through the recipe's uninstall (#3120).
  const contribution = resolveCatalogContribution(id);
  if (contribution) {
    return runHarnessUninstall(id, contribution.installRecipe, flags);
  }

  const gate = coherenceGate(flags, "uninstall");
  if (gate !== 0) return gate;

  if (flags.dryRun) {
    emit(
      flags,
      `[dry-run] would uninstall '${id}'${flags.purge ? " and purge its data" : ""}`,
      {
        ok: true,
        action: "uninstall",
        dryRun: true,
        id,
        purge: flags.purge,
      }
    );
    return 0;
  }

  // Confirmation: skipped with --yes; refused (never prompts) in non-interactive mode.
  if (!flags.yes) {
    if (!process.stdin.isTTY) {
      emitError(
        flags,
        `refusing to uninstall '${id}' without confirmation in non-interactive mode — pass --yes`,
        "confirmation_required"
      );
      return 1;
    }
    const purgeNote = flags.purge
      ? " and PURGE its stored data (irreversible)"
      : "";
    const ok = await confirm(`Uninstall extension '${id}'${purgeNote}?`);
    if (!ok) {
      emit(flags, "Aborted.", {
        ok: true,
        action: "uninstall",
        aborted: true,
        id,
      });
      return 0;
    }
  }

  try {
    const { purgedTables, prefRemoved } = uninstallExtension(
      id,
      extensionsDir(),
      {
        purge: flags.purge,
      }
    );
    const purgeLine = flags.purge
      ? `\n  Purged ${purgedTables.length} data table(s)${prefRemoved ? " + preference row" : ""}.`
      : "";
    emit(flags, `✅ Uninstalled ${id}${purgeLine}`, {
      ok: true,
      action: "uninstall",
      id,
      purge: flags.purge,
      purgedTables,
      prefRemoved,
    });
    return 0;
  } catch (err) {
    const code =
      err instanceof ExtensionNotInstalledError
        ? "not_installed"
        : "uninstall_failed";
    emitError(flags, (err as Error).message, code);
    return 1;
  }
}

function runList(flags: ParsedFlags): number {
  const extensions = listInstalledExtensions(extensionsDir());
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, extensions }, null, 2));
    return 0;
  }
  if (extensions.length === 0) {
    console.log("No extensions installed.");
    return 0;
  }
  const header = {
    id: "ID",
    displayName: "NAME",
    version: "VERSION",
    source: "SOURCE",
    state: "STATE",
  };
  const rows = extensions.map(e => ({
    id: e.id,
    displayName: e.displayName,
    version: e.version,
    source: e.source,
    state: e.enabled ? "enabled" : "disabled",
  }));
  const widths = {
    id: Math.max(header.id.length, ...rows.map(r => r.id.length)),
    displayName: Math.max(
      header.displayName.length,
      ...rows.map(r => r.displayName.length)
    ),
    version: Math.max(
      header.version.length,
      ...rows.map(r => r.version.length)
    ),
    source: Math.max(header.source.length, ...rows.map(r => r.source.length)),
  };
  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (r: typeof header) =>
    `${pad(r.id, widths.id)}  ${pad(r.displayName, widths.displayName)}  ${pad(r.version, widths.version)}  ${pad(r.source, widths.source)}  ${r.state}`;
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  return 0;
}

async function runUpdate(
  id: string | undefined,
  flags: ParsedFlags
): Promise<number> {
  const gate = coherenceGate(flags, "update");
  if (gate !== 0) return gate;
  if (flags.dryRun) {
    emit(
      flags,
      `[dry-run] would update ${id ? `'${id}'` : "all filesystem extensions"}`,
      {
        ok: true,
        action: "update",
        dryRun: true,
        id: id ?? null,
      }
    );
    return 0;
  }
  const outcomes = await updateExtensions(extensionsDir(), id);
  if (flags.json) {
    console.log(
      JSON.stringify({ ok: true, action: "update", outcomes }, null, 2)
    );
  } else if (outcomes.length === 0) {
    console.log("No filesystem extensions to update.");
  } else {
    for (const o of outcomes) {
      const icon =
        o.status === "updated" ? "✅" : o.status === "skipped" ? "⏭️" : "❌";
      console.log(`${icon} ${o.id}: ${o.status} — ${o.detail}`);
    }
  }
  const anyFailed = outcomes.some(o => o.status === "failed");
  return anyFailed ? 1 : 0;
}

function printHelp(isError = false): number {
  const out = isError ? console.error : console.log;
  out(
    "Usage: hapi ext <install|enable|disable|uninstall|list|update|version|assert-stock|catalog> [args] [flags]"
  );
  out("");
  out("Subcommands:");
  out(
    "  install <path|url|id|harness> [--json]  Install an extension from a local path, URL,"
  );
  out(
    "                                     a <publisher>.<name> catalog id (#1292), or a catalog"
  );
  out(
    "                                     CLI-harness id (#3120, e.g. 'crush' — runs its recipe)."
  );
  out(
    "  version <harness-id> [--json]      Probe the installed version of a catalog CLI harness (#3120)."
  );
  out(
    "  catalog [--json]                   List the CLI-harness catalog (recipe + installed version, #3120)."
  );
  out(
    "  enable <id> [--json]               Enable an extension (takes effect on restart)"
  );
  out(
    "  disable <id> [--json]              Disable an extension (takes effect on restart)"
  );
  out(
    "  uninstall <id> [--purge] [--yes]   Remove an extension; --purge also drops its data"
  );
  out(
    "  list [--json]                      List installed extensions with enabled state"
  );
  out(
    "  update [<id>] [--json]             Update one filesystem extension, or all"
  );
  out(
    "  assert-stock [--json]              Assert the stock 4 (claude,codex,gemini,opencode) are"
  );
  out(
    "                                     present + pinned-version-matched (provision/deploy — #3120)."
  );
  out("");
  out(
    "Flags: --json  --force (bypass instance-coherence)  --yes (skip confirm)  --dry-run"
  );
  out("");
  out(
    "Note: filesystem extensions load only when HAPI_FS_EXTENSIONS is set (default OFF)."
  );
  return isError ? 1 : 0;
}

export const extCommand: CommandDefinition = {
  name: "ext",
  requiresRuntimeAssets: false,
  run: async ({ commandArgs }) => {
    const sub = commandArgs[0];
    const rest = commandArgs.slice(1);
    const flags = parseFlags(rest);
    const operand = firstOperand(rest);
    let exit = 0;
    switch (sub) {
      case "install":
        exit = await runInstall(operand, flags);
        break;
      case "enable":
        exit = runToggle(operand, true, flags);
        break;
      case "disable":
        exit = runToggle(operand, false, flags);
        break;
      case "uninstall":
        exit = await runUninstall(operand, flags);
        break;
      case "list":
        exit = runList(flags);
        break;
      case "update":
        exit = await runUpdate(operand, flags);
        break;
      case "version":
        exit = await runVersion(operand, flags);
        break;
      case "assert-stock":
        exit = await runAssertStock(flags);
        break;
      case "catalog":
        exit = await runCatalog(flags);
        break;
      case undefined:
        exit = printHelp(false);
        break;
      default:
        console.error(`Error: unknown subcommand '${sub}'`);
        console.error("");
        exit = printHelp(true);
    }
    process.exit(exit);
  },
};
