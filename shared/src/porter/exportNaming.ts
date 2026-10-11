// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — export-directory + archive-naming surface
 * (epic #2339, issue #3239).
 *
 * The extraction prompt (#2342, `extractionPrompt.ts`) assembles the config
 * archive in a throwaway `mktemp -d` staging dir as `config-port.tar.gz`, then
 * MOVES it into a stable, predefined export directory under a timestamped,
 * machine-named filename. This module is the single source of truth for that
 * export convention:
 *
 *   - {@link EXPORT_DIR_ENV} — the env var that overrides the export directory.
 *   - {@link DEFAULT_EXPORT_DIR} — the shell-resolvable default when it is unset.
 *   - {@link EXPORT_TIMESTAMP_FORMAT} — the `date -u +…` UTC timestamp format
 *     used for the filename prefix.
 *   - {@link EXPORT_NAME_STEM} — the descriptive middle segment of the filename.
 *   - {@link buildExportShellFragment} — a PURE builder that emits the
 *     DEST-resolve / mkdir / timestamped-BASE / collision-suffix / move / report
 *     `sh` fragment the prompt's Step 11 interpolates.
 *
 * COORDINATION (epic #2339 F4, expert-review R5): #3239 DEFINES this surface and
 * #3245's `buildExportScript` CONSUMES it — the export dir + filename strings
 * live ONLY here, never inlined at either call site, so the two issues cannot
 * drift apart.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this file
 * imports no `node:*` builtin — it produces SHELL TEXT (`$HOME/config-export`,
 * `$(hostname)`, `$(date -u …)`), it never resolves a path or reads env at
 * runtime. The `manifest.test.ts` R7 guard scans every non-test `.ts` here for a
 * static `node:` import specifier and would fail the build if one were added.
 * (`ARCHIVE_FORMAT` is imported from the sibling `version.ts`, a `shared` import,
 * not a `node:` builtin.)
 */
import { ARCHIVE_FORMAT } from "./version";

/**
 * Env var that overrides the export directory (E1). Mirrors `CLAUDE_CONFIG_DIR`:
 * unset → {@link DEFAULT_EXPORT_DIR}; set → that path is used verbatim.
 */
export const EXPORT_DIR_ENV = "HAPI_PORTER_EXPORT_DIR" as const;

/**
 * The default export directory when {@link EXPORT_DIR_ENV} is unset (E1/R-B1).
 * Held in SHELL-RESOLVABLE form (`$HOME/config-export`, not `~/config-export`)
 * because it is substituted into a `${VAR:-DEFAULT}` shell fallback, where tilde
 * expansion is not reliable after `:-` in POSIX `sh`. The human-facing prose in
 * the prompt header shows the `~/config-export` display form; the generated
 * shell fragment uses this shell-resolvable value.
 */
export const DEFAULT_EXPORT_DIR = "$HOME/config-export" as const;

/**
 * The `date -u +…` format for the archive filename's UTC timestamp prefix
 * (R-B2/E3): `%Y-%m-%dT%H%M%SZ` → e.g. `2026-08-24T143205Z`. Colon-free — `:` is
 * unsafe in filenames on several filesystems — yet still lexically sortable and
 * unambiguously UTC (`Z`). Distinct from the manifest's `generatedAt`, which
 * keeps its human ISO `%Y-%m-%dT%H:%M:%SZ` form (that value is JSON, not a
 * filename).
 */
export const EXPORT_TIMESTAMP_FORMAT = "%Y-%m-%dT%H%M%SZ" as const;

/** The descriptive middle segment of the export filename (`<UTC>-config-export-<host>`). */
export const EXPORT_NAME_STEM = "config-export" as const;

/** Input to {@link buildExportShellFragment}. */
export interface ExportShellFragmentInput {
  /**
   * The archive filename produced in the staging dir, which the fragment moves
   * into the export dir. Defaults to the porter staging name
   * `config-port.${ARCHIVE_FORMAT}` — kept as the staging name for
   * test-compatibility (#3239 only ADDS a move step; it does not rename the tar
   * command's output).
   */
  stagingArchiveName?: string;
}

/**
 * Emit the POSIX-`sh` fragment that moves the staged archive into the stable
 * export directory under a timestamped, machine-named filename
 * (R-B1/R-B2/E1/E2/E3/R-B3). PURE — returns TEXT, performs no I/O.
 *
 * The emitted fragment, in order:
 *   1. `DEST="${HAPI_PORTER_EXPORT_DIR:-$HOME/config-export}"` + `mkdir -p "$DEST"` (E1/R-B1)
 *   2. a UTC `date -u` stamp + `$(hostname)`, tolerant of an empty hostname —
 *      the host segment is simply omitted and the export still succeeds (R-B2/E3)
 *   3. a collision loop that appends `-2`, `-3`, … before `.${ARCHIVE_FORMAT}`
 *      until the destination path is free — it NEVER overwrites (E2)
 *   4. `mv <staging> "$DEST/$FINAL"` — a single move+rename, NO second/backup
 *      copy (R-B3)
 *   5. `echo "$DEST/$FINAL"` — the absolute path the user uploads
 *
 * `BASE` is the extension-less filename stem so the collision suffix inserts
 * cleanly before the `.${ARCHIVE_FORMAT}` extension (semantically identical to
 * the directive's `BASE.tar.gz` + "insert -N before .tar.gz", just cleaner in
 * `sh`).
 */
export function buildExportShellFragment(
  input: ExportShellFragmentInput = {}
): string {
  const staging = input.stagingArchiveName ?? `config-port.${ARCHIVE_FORMAT}`;
  const ext = `.${ARCHIVE_FORMAT}`;
  return [
    `# Move the staging archive into the stable export directory under a`,
    `# timestamped, machine-named filename; never overwrite an existing export.`,
    `DEST="\${${EXPORT_DIR_ENV}:-${DEFAULT_EXPORT_DIR}}"`,
    `mkdir -p "$DEST"`,
    `HOST="$(hostname 2>/dev/null || true)"`,
    `if [ -n "$HOST" ]; then`,
    `  BASE="$(date -u +${EXPORT_TIMESTAMP_FORMAT})-${EXPORT_NAME_STEM}-$HOST"`,
    `else`,
    `  BASE="$(date -u +${EXPORT_TIMESTAMP_FORMAT})-${EXPORT_NAME_STEM}"`,
    `fi`,
    `FINAL="$BASE${ext}"`,
    `N=2`,
    `while [ -e "$DEST/$FINAL" ]; do`,
    `  FINAL="$BASE-$N${ext}"`,
    `  N=$((N + 1))`,
    `done`,
    `mv ${staging} "$DEST/$FINAL"`,
    `echo "$DEST/$FINAL"`,
  ].join("\n");
}

/**
 * Emit the PowerShell fragment that moves the staged archive into the stable
 * export directory under a timestamped, machine-named filename — the exact twin
 * of {@link buildExportShellFragment} for the Windows-native PowerShell export
 * (#3447 Sub B, 1B#23). PURE — returns TEXT, performs no I/O. Same
 * DEST/timestamp/`-N`-collision/move/report semantics, rendered in PowerShell:
 *   1. `$DEST` from `$env:HAPI_PORTER_EXPORT_DIR`, else `Join-Path $HOME
 *      config-export` (the {@link DEFAULT_EXPORT_DIR} default, minus its `$HOME/`
 *      prefix so `Join-Path` composes it) (E1/R-B1)
 *   2. a UTC `[DateTime]::UtcNow` stamp + `[Net.Dns]::GetHostName()`, tolerant of
 *      an empty/unresolvable hostname — the host segment is omitted and the
 *      export still succeeds (R-B2/E3)
 *   3. a collision loop appending `-2`, `-3`, … before `.${ARCHIVE_FORMAT}` until
 *      the path is free — it NEVER overwrites (E2)
 *   4. `Move-Item` — a single move+rename, no second copy (R-B3)
 *   5. `Write-Output` of the absolute path — the sole stdout line (the twin of
 *      the bash `echo "$DEST/$FINAL"`)
 *
 * The staged archive is addressed as `Join-Path $STAGING <name>` (the emitter's
 * staging-dir variable), NOT via the current location — a PowerShell location and
 * the process CWD can differ, so the relative name the bash fragment uses after
 * its `cd` would be unsafe here.
 *
 * The .NET timestamp format `yyyy-MM-dd\THHmmss\Z` is the .NET equivalent of
 * {@link EXPORT_TIMESTAMP_FORMAT} (`%Y-%m-%dT%H%M%SZ`): colon-free, sortable, UTC.
 * `\T`/`\Z` are escaped literals (T/Z are not .NET custom format specifiers, but
 * escaping keeps them unambiguously literal across culture settings).
 */
export function buildExportPowerShellFragment(
  input: ExportShellFragmentInput = {}
): string {
  const staging = input.stagingArchiveName ?? `config-port.${ARCHIVE_FORMAT}`;
  // Single-source the default sub-directory from DEFAULT_EXPORT_DIR (the DIR
  // authority) rather than re-deriving it — `$HOME/config-export` → `config-export`.
  const defaultSubdir = DEFAULT_EXPORT_DIR.replace(/^\$HOME\//, "");
  return [
    `# Move the staging archive into the stable export directory under a`,
    `# timestamped, machine-named filename; never overwrite an existing export.`,
    `$DEST = if ($env:${EXPORT_DIR_ENV}) { $env:${EXPORT_DIR_ENV} } else { Join-Path $HOME '${defaultSubdir}' }`,
    `New-Item -ItemType Directory -Force -Path $DEST | Out-Null`,
    `$STAMP = [DateTime]::UtcNow.ToString('yyyy-MM-dd\\THHmmss\\Z')`,
    `$EXPORT_HOST = try { [Net.Dns]::GetHostName() } catch { '' }`,
    `if ($EXPORT_HOST) {`,
    `  $BASE = "$STAMP-${EXPORT_NAME_STEM}-$EXPORT_HOST"`,
    `} else {`,
    `  $BASE = "$STAMP-${EXPORT_NAME_STEM}"`,
    `}`,
    `$FINAL = "$BASE.${ARCHIVE_FORMAT}"`,
    `$N = 2`,
    `while (Test-Path -LiteralPath (Join-Path $DEST $FINAL)) {`,
    `  $FINAL = "$BASE-$N.${ARCHIVE_FORMAT}"`,
    `  $N++`,
    `}`,
    `Move-Item -LiteralPath (Join-Path $STAGING '${staging}') -Destination (Join-Path $DEST $FINAL)`,
    `Write-Output (Join-Path $DEST $FINAL)`,
  ].join("\n");
}
