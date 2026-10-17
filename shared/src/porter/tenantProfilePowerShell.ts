// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the PowerShell lines of the `tenant` export profile
 * (issue #4373, R2) and of the hygiene gate step, a sibling of
 * `exportScriptPowerShell.ts` so that file grows only by its call sites (the
 * `settingsScriptPowerShell.ts` precedent). The bash twin is
 * `tenantProfileShell.ts`; the #3447 equivalence harness pins the two.
 *
 * The lines run inside the PowerShell exporter's main block and rely on its
 * helpers and state: `recordOmission`, `pruneCredentialNames`,
 * `linkRootRefusal`, `copyTreeExcluding`, `stagedChildren`, `stagedRel`,
 * `removeStaged`, `isKebab`, `$CONFIG_ROOT`, `$STAGING`, `$STG_FULL`,
 * `$HOME_DIR`, `$WORK`, `$TAR` and, for the premium filter, Step 8's
 * `$kmObj`, `$markets` and `$plugs`.
 *
 * NODE-FREE: string builders only.
 */
import {
  MEMORY_ARCHIVE_DIR,
  MEMORY_LINK_OMISSION_REASON,
  MEMORY_PROJECT_LINK_OMISSION_REASON,
  PREMIUM_MARKETPLACE_NAMES,
  PREMIUM_MARKETPLACE_SOURCE_PATTERN,
  TENANT_PREMIUM_OMISSION,
  type PorterExportProfile,
} from "./tenantProfile";
import { archiveHygienePowerShellLines } from "./archiveHygiene";
import { psq } from "./exportShared";
import {
  VM_CLASS_ENV,
  VM_CLASS_MARKER_REL,
  VM_CLASS_OPERATOR,
  VM_TIER_ENV,
  VM_TIER_MARKER_REL,
} from "../vmClass";

/**
 * The profile lines (the bash twin's K13 check): `$EXPORT_PROFILE` is the
 * minted profile, forced to `tenant` on a hosted customer VM. `$PROFILE` is
 * PowerShell's own profile path, so the name differs.
 */
export function profileDetectionPowerShellLines(
  profile: PorterExportProfile
): string[] {
  return [
    "    # ---- #4373 - the export profile (the bash twin's K13 check) ----",
    "    # The destination minted this script and cannot know it runs on a hosted",
    "    # customer VM, so the VM's own markers decide and force the tenant profile.",
    `    $EXPORT_PROFILE = ${psq(profile)}`,
    `    $vtPath = Join-Path $HOME_DIR ${psq(VM_TIER_MARKER_REL)}`,
    `    $vcPath = Join-Path $HOME_DIR ${psq(VM_CLASS_MARKER_REL)}`,
    "    # Each value: its env override, else the marker file; case and spaces ignored.",
    `    $vt = [string][Environment]::GetEnvironmentVariable(${psq(VM_TIER_ENV)})`,
    "    if ((-not $vt) -and (Test-Path -LiteralPath $vtPath -PathType Leaf)) { $vt = [string](Get-Content -Raw -LiteralPath $vtPath) }",
    `    $vc = [string][Environment]::GetEnvironmentVariable(${psq(VM_CLASS_ENV)})`,
    "    if ((-not $vc) -and (Test-Path -LiteralPath $vcPath -PathType Leaf)) { $vc = [string](Get-Content -Raw -LiteralPath $vcPath) }",
    "    $vt = $vt -replace '\\s', ''",
    "    $vc = ($vc -replace '\\s', '').ToLowerInvariant()",
    `    if ($vt -and ($vc -cne ${psq(VM_CLASS_OPERATOR)})) {`,
    "      if ($EXPORT_PROFILE -ne 'tenant') {",
    "        [Console]::Error.WriteLine('note: this is a hosted customer VM, so the export uses the tenant profile')",
    "        [Console]::Error.WriteLine('      (your own skills, agents, hooks, settings and memory; no premium packs).')",
    "      }",
    "      $EXPORT_PROFILE = 'tenant'",
    "    }",
  ];
}

/**
 * Step 4c (the bash twin's): stage `projects/<key>/memory/**` under
 * `memory/<key>/` (tenant only) and set `$MEMORY`. Copied as it is (no -h),
 * every link in it removed and recorded in byte order; a linked `projects/`
 * folder is checked once; a linked project folder is never descended and is
 * recorded with `MEMORY_PROJECT_LINK_OMISSION_REASON`.
 */
export function memoryStagingPowerShellLines(): string[] {
  const M = psq(MEMORY_ARCHIVE_DIR);
  const MSLASH = psq(MEMORY_ARCHIVE_DIR + "/");
  const LINK = psq(MEMORY_LINK_OMISSION_REASON);
  const PROJECT_LINK = psq(MEMORY_PROJECT_LINK_OMISSION_REASON);
  return [
    "    # ---- Step 4c - #4373: the tenant profile's auto-memory (no step call) ----",
    "    $MEMORY = $null",
    "    $projRoot = Join-Path $CONFIG_ROOT 'projects'",
    "    if (($EXPORT_PROFILE -eq 'tenant') -and (Test-Path -LiteralPath $projRoot -PathType Container)) {",
    "      $mref = linkRootRefusal $projRoot",
    `      if ($mref) { recordOmission ${M} $mref }`,
    "      else {",
    "        $projFull = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($projRoot))",
    "        $mkeys = [string[]]@((New-Object IO.DirectoryInfo $projFull).EnumerateDirectories() | ForEach-Object { $_.Name })",
    "        [Array]::Sort($mkeys, [StringComparer]::Ordinal)",
    `        $memStage = Join-Path $STAGING ${M}`,
    "        foreach ($mkey in $mkeys) {",
    "          $kdir = New-Object IO.DirectoryInfo ([IO.Path]::Combine($projFull, $mkey))",
    "          if ($kdir.Attributes -band [IO.FileAttributes]::ReparsePoint) { recordOmission (" +
      MSLASH +
      " + $mkey) " +
      PROJECT_LINK +
      "; continue }",
    "          $mdPath = [IO.Path]::Combine($kdir.FullName, 'memory')",
    "          $mdAttr = (New-Object IO.FileInfo $mdPath).Attributes",
    "          if ([int]$mdAttr -eq -1) { continue }",
    "          if ($mdAttr -band [IO.FileAttributes]::ReparsePoint) { recordOmission (" +
      MSLASH +
      " + $mkey) " +
      LINK +
      "; continue }",
    "          if (-not ($mdAttr -band [IO.FileAttributes]::Directory)) { continue }",
    "          if (-not (copyTreeExcluding $mdPath (Join-Path $memStage $mkey))) { throw ('tar failed collecting the memory of ' + $mkey) }",
    "        }",
    "        if (Test-Path -LiteralPath $memStage -PathType Container) {",
    "          # Links, in byte order so both exporters record them alike.",
    `          $memInfo = New-Object IO.DirectoryInfo ([IO.Path]::Combine($STG_FULL, ${M}))`,
    "          $mlinks = New-Object 'System.Collections.Generic.Dictionary[string,System.IO.FileSystemInfo]' ([StringComparer]::Ordinal)",
    "          $mpending = New-Object 'System.Collections.Generic.Queue[object]'",
    "          $mpending.Enqueue($memInfo)",
    "          while ($mpending.Count -gt 0) {",
    "            foreach ($e in (stagedChildren $mpending.Dequeue())) {",
    "              if ($e.Attributes -band [IO.FileAttributes]::ReparsePoint) { $mlinks[(stagedRel $e.FullName)] = $e }",
    "              elseif ($e -is [IO.DirectoryInfo]) { $mpending.Enqueue($e) }",
    "            }",
    "          }",
    "          $mrels = [string[]]@($mlinks.Keys)",
    "          [Array]::Sort($mrels, [StringComparer]::Ordinal)",
    `          foreach ($mrel in $mrels) { recordOmission $mrel ${LINK}; removeStaged $mlinks[$mrel] }`,
    `          pruneCredentialNames ${M}`,
    "          # One entry per project folder that still holds a file; an empty one goes.",
    "          $mentries = @()",
    "          $mnames = [string[]]@(stagedChildren $memInfo | Where-Object { $_ -is [IO.DirectoryInfo] } | ForEach-Object { $_.Name })",
    "          [Array]::Sort($mnames, [StringComparer]::Ordinal)",
    "          foreach ($mn in $mnames) {",
    "            $kd = New-Object IO.DirectoryInfo ([IO.Path]::Combine($memInfo.FullName, $mn))",
    "            if (@($kd.EnumerateFiles('*', [IO.SearchOption]::AllDirectories)).Count -gt 0) {",
    `              $mentries += ([ordered]@{ projectKey = $mn; path = (${MSLASH} + $mn) })`,
    "            } else { removeStaged $kd }",
    "          }",
    "          if ($mentries.Count -gt 0) {",
    "            $MEMORY = [ordered]@{ sourceHomeKey = ($HOME_DIR -replace '[^A-Za-z0-9]', '-'); entries = @($mentries) }",
    "          } else { removeStaged $memInfo }",
    "        }",
    "      }",
    "    }",
  ];
}

/**
 * Step 8 (tenant, the bash twin's jq filter): drop every marketplace and
 * plugin whose marketplace is the licensed premium one, by name or by its
 * source (read from the raw `$kmObj`), and record one omission.
 */
export function premiumFilterPowerShellLines(): string[] {
  const om = TENANT_PREMIUM_OMISSION;
  return [
    "      # #4373: the tenant profile drops every premium marketplace and plugin.",
    "      if ($EXPORT_PROFILE -eq 'tenant') {",
    `        $premRe = [regex]::new(${psq(PREMIUM_MARKETPLACE_SOURCE_PATTERN)}, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)`,
    `        $premNames = @(${PREMIUM_MARKETPLACE_NAMES.map(psq).join(", ")})`,
    "        if ($kmObj) {",
    "          foreach ($mp in $kmObj.PSObject.Properties) {",
    "            $ps = propOrNull $mp.Value 'source'",
    "            $pv = $null",
    "            if ($null -ne $ps) { if ($ps -is [string]) { $pv = $ps } else { $pv = propOrNull $ps 'repo'; if ($null -eq $pv) { $pv = propOrNull $ps 'url' } } }",
    "            if (($pv -is [string]) -and $premRe.IsMatch($pv)) { $premNames += $mp.Name }",
    "          }",
    "        }",
    "        $before = $markets.Count + $plugs.Count",
    "        $markets = @($markets | Where-Object { -not (($premNames -ccontains $_.name) -or (($_.source -is [string]) -and $premRe.IsMatch($_.source))) })",
    "        $plugs = @($plugs | Where-Object { -not ($premNames -ccontains $_.marketplace) })",
    `        if (($markets.Count + $plugs.Count) -lt $before) { recordOmission ${psq(om.surface)} ${psq(om.reason)} }`,
    "      }",
  ];
}

/**
 * Step 11.5 (the bash twin's hygiene gate): check the built archive at
 * `$stagingArchive` before its path is printed or it is uploaded; on a hit,
 * delete it, name each rule and file, and stop.
 */
export function hygieneGatePowerShellLines(): string[] {
  return [
    "    # ---- Step 11.5 - #4373 (R5): the hygiene gate (no step call) ----",
    "    # An archive copied off this machine cannot be recalled, so it is checked",
    "    # before its path is printed or it is uploaded; on a hit it is deleted.",
    ...archiveHygienePowerShellLines(),
    "    $hygDir = Join-Path $WORK 'hygiene'",
    "    New-Item -ItemType Directory -Force -Path $hygDir | Out-Null",
    "    $hygHits = @(porterArchiveHygiene $stagingArchive $hygDir)",
    "    if ($hygHits.Count -gt 0) {",
    "      Remove-Item -LiteralPath $stagingArchive -Force -ErrorAction SilentlyContinue",
    "      [Console]::Error.WriteLine('')",
    "      [Console]::Error.WriteLine('error: the archive failed its hygiene check, so it was deleted and nothing')",
    "      [Console]::Error.WriteLine('was written or uploaded. Each line names the rule and the file:')",
    "      foreach ($h in $hygHits) { [Console]::Error.WriteLine('  ' + $h) }",
    "      [Console]::Error.WriteLine('Remove the secret (or the file) from your configuration, then run the export again.')",
    "      throw 'porter: the archive failed its hygiene check'",
    "    }",
  ];
}
