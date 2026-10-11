// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the PowerShell twin of `./settingsScriptShell`: the
 * export's Step 7b, the top-level script an executable setting runs
 * (issue #4173). A sibling module so `exportScriptPowerShell.ts` grows only by
 * its call site (epic #4290 B4).
 *
 * It renders the same `./settingsScripts` constants for .NET: the reference,
 * word-split and outside patterns as they are (they use only the regex subset
 * jq, .NET and JavaScript share), the name rule's `\z`/`(?s)` form, and never
 * an IgnoreCase flag in a classification (.NET IgnoreCase folds U+212A and
 * U+017F onto ASCII letters). The `$HOME/.claude` reference is resolved
 * against `$HOME_DIR` (USERPROFILE, else HOME), the PowerShell spelling of the
 * bash `$HOME`. The #3447 equivalence harness pins its manifest to the bash
 * one.
 *
 * NODE-FREE (R7): like every non-test module under `shared/src/porter`, this
 * file only builds strings.
 */
import {
  SETTINGS_SCRIPTS_DIR,
  SETTINGS_SCRIPT_CREDENTIAL_PATTERN,
  SETTINGS_SCRIPT_NAME_PATTERN_DOTNET,
  SETTINGS_SCRIPT_OUTSIDE_START_PATTERN,
  SETTINGS_SCRIPT_REF_PATTERN,
  SETTINGS_SCRIPT_REF_START_PATTERN,
  SETTINGS_SCRIPT_SECTION_FOLDERS,
  SETTINGS_SCRIPT_SKIP_REASONS,
  SETTINGS_SCRIPT_SURFACE_PREFIX,
  SETTINGS_SCRIPT_WORD_SPLIT_PATTERN,
} from "./settingsScripts";

/** A PowerShell single-quoted string literal for `s` (embedded doubling of `'`). */
function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The PowerShell lines of Step 7b, indented for the exporter's main block.
 *
 * Caller contract: `$HOME_DIR`, `$STAGING`, `$ON_WINDOWS` and `$SETTINGS` (the
 * Step 7 ordered dictionary) are set; `recordOmission`, `propOrNull`,
 * `isCredentialName`, `hasCredentialPart` and `physicalPath` are defined. The
 * lines set `$SETTINGS_SCRIPTS` (the manifest's `settingsScripts`) and
 * normalize the two executable values in `$SETTINGS` in place (D3).
 *
 * D3 needles: on Linux-pwsh only `$HOME_DIR/.claude/`, replaced as an ordinal,
 * case-sensitive literal (as bash's jq split/join). On Windows also
 * `$HOME_DIR\.claude\`, the forward-slash spelling of `$HOME_DIR` itself
 * (`C:/Users/<u>/.claude/`, the common JSON spelling) and the
 * `%USERPROFILE%` forms, each case-insensitive (the hook-command
 * normalization precedent), because Windows paths are.
 */
export function settingsScriptPowerShellLines(): string[] {
  const r = SETTINGS_SCRIPT_SKIP_REASONS;
  const omit = (reason: string): string =>
    `recordOmission $ssSurf ${psq(reason)}`;
  return [
    "    # ---- Step 7b - #4173: the top-level script an executable setting runs ----",
    "    # (no step call: the step count and progress bar are unchanged). A",
    "    # reference is resolved against $HOME_DIR\\.claude, the path the shell runs,",
    "    # never the config root (a session terminal's CLAUDE_CONFIG_DIR differs).",
    "    $SETTINGS_SCRIPTS = @()",
    "    # D3: the literal <home>/.claude/ prefix becomes $HOME/.claude/ in the two values.",
    "    $ssNeedles = @($HOME_DIR + '/.claude/')",
    "    if ($ON_WINDOWS) {",
    "      $ssNeedles = @(($HOME_DIR + '/.claude/'), ($HOME_DIR + '\\.claude\\'), (($HOME_DIR -replace '\\\\', '/') + '/.claude/'), '%USERPROFILE%\\.claude\\', '%USERPROFILE%/.claude/')",
    "    }",
    "    function ssNormalize($v) {",
    "      $out = $v",
    "      foreach ($n in $ssNeedles) {",
    "        if ($ON_WINDOWS) { $out = [regex]::Replace($out, [regex]::Escape($n), '$$HOME/.claude/', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) }",
    "        else { $out = $out.Replace($n, '$HOME/.claude/') }",
    "      }",
    "      return $out",
    "    }",
    "    function ssCommand($k) {",
    "      if ($k -eq 'apiKeyHelper') {",
    "        if ($SETTINGS.Contains('apiKeyHelper') -and ($SETTINGS['apiKeyHelper'] -is [string])) { return $SETTINGS['apiKeyHelper'] }",
    "        return $null",
    "      }",
    "      if ($SETTINGS.Contains('statusLine') -and ($SETTINGS['statusLine'] -is [System.Management.Automation.PSCustomObject])) {",
    "        $ssCmd = propOrNull $SETTINGS['statusLine'] 'command'",
    "        if ($ssCmd -is [string]) { return $ssCmd }",
    "      }",
    "      return $null",
    "    }",
    "    if ($null -ne (ssCommand 'apiKeyHelper')) { $SETTINGS['apiKeyHelper'] = ssNormalize $SETTINGS['apiKeyHelper'] }",
    "    if ($null -ne (ssCommand 'statusLine')) { $SETTINGS['statusLine'].command = ssNormalize $SETTINGS['statusLine'].command }",
    `    $ssRefPat = ${psq(SETTINGS_SCRIPT_REF_PATTERN)}`,
    `    $ssRefStart = ${psq(SETTINGS_SCRIPT_REF_START_PATTERN)}`,
    `    $ssOutStart = ${psq(SETTINGS_SCRIPT_OUTSIDE_START_PATTERN)}`,
    `    $ssSplit = ${psq(SETTINGS_SCRIPT_WORD_SPLIT_PATTERN)}`,
    `    $ssNamePat = ${psq(SETTINGS_SCRIPT_NAME_PATTERN_DOTNET)}`,
    `    $ssCredPat = ${psq(SETTINGS_SCRIPT_CREDENTIAL_PATTERN)}`,
    `    $ssSections = @(${SETTINGS_SCRIPT_SECTION_FOLDERS.map(psq).join(", ")})`,
    "    # The name rule, in the order every dialect applies (./settingsScripts).",
    "    function ssVerdict($rel) {",
    "      $w = '/' + $rel + '/'",
    "      if ($w.Contains('//') -or $w.Contains('/./') -or $w.Contains('/../')) { return 'notCanonical' }",
    "      $segs = $rel.Split([char[]]@('/'))",
    "      if ($segs.Count -ge 2) {",
    "        if ($ssSections -ccontains $segs[0]) { return 'section' }",
    "        return 'notTopLevel'",
    "      }",
    "      if (isCredentialName $rel) { return 'credentialName' }",
    "      if (-not [regex]::IsMatch($rel, $ssNamePat)) { return 'notScript' }",
    "      return 'ok'",
    "    }",
    "    # Each reference in a command (unique by the whole match, ordinal order),",
    "    # then each word that names a file outside the config root (unique,",
    "    # ordinal order): rows of { ref, rel }, rel $null for an outside word.",
    "    function ssRows($ssC) {",
    "      $ssRows = New-Object 'System.Collections.Generic.List[object]'",
    "      $ssRefMap = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)",
    "      foreach ($ssM in [regex]::Matches($ssC, $ssRefPat)) { if (-not $ssRefMap.ContainsKey($ssM.Value)) { $ssRefMap[$ssM.Value] = $ssM.Groups[2].Value } }",
    "      $ssRefs = [string[]]@($ssRefMap.Keys)",
    "      [Array]::Sort($ssRefs, [StringComparer]::Ordinal)",
    "      foreach ($ssRef in $ssRefs) { $ssRows.Add([ordered]@{ ref = $ssRef; rel = $ssRefMap[$ssRef] }) }",
    "      $ssOut = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)",
    "      foreach ($ssW0 in [regex]::Split($ssC, $ssSplit)) {",
    "        if ($ssW0.Length -eq 0) { continue }",
    `        $ssW = [regex]::Replace([regex]::Replace($ssW0, ${psq(`^["']`)}, ''), ${psq(`["']$`)}, '')`,
    "        if ([regex]::IsMatch($ssW, $ssOutStart) -and (-not [regex]::IsMatch($ssW, $ssRefStart)) -and (-not $ssW.StartsWith('/dev/', [StringComparison]::Ordinal))) { [void]$ssOut.Add($ssW) }",
    "      }",
    "      $ssOutArr = [string[]]@($ssOut)",
    "      [Array]::Sort($ssOutArr, [StringComparer]::Ordinal)",
    "      foreach ($ssW in $ssOutArr) { $ssRows.Add([ordered]@{ ref = $ssW; rel = $null }) }",
    "      return ,$ssRows",
    "    }",
    "    $ssCarried = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)",
    "    foreach ($ssKey in @('apiKeyHelper', 'statusLine')) {",
    "      $ssC = ssCommand $ssKey",
    "      if ($null -eq $ssC) { continue }",
    "      foreach ($ssRow in (ssRows $ssC)) {",
    `        $ssSurf = ${psq(SETTINGS_SCRIPT_SURFACE_PREFIX)} + $ssKey + ' runs ' + $ssRow['ref']`,
    "        $ssRel = $ssRow['rel']",
    `        if ($null -eq $ssRel) { ${omit(r.outsideConfigRoot)}; continue }`,
    "        $ssV = ssVerdict $ssRel",
    `        if ($ssV -eq 'notCanonical') { ${omit(r.notCanonical)}; continue }`,
    `        if ($ssV -eq 'notTopLevel') { ${omit(r.notTopLevel)}; continue }`,
    `        if ($ssV -eq 'credentialName') { ${omit(r.credentialName)}; continue }`,
    `        if ($ssV -eq 'notScript') { ${omit(r.notScript)}; continue }`,
    "        if ($ssV -eq 'section') {",
    "          # The section's own export carries it; report only when it did not.",
    `          if (-not (Test-Path -LiteralPath (Join-Path $STAGING $ssRel) -PathType Leaf)) { ${omit(r.sectionNotStaged)} }`,
    "          continue",
    "        }",
    "        # Two keys naming one file carry it once; a failure is reported per key.",
    "        if ($ssCarried.Contains($ssRel)) { continue }",
    "        # The #4154 link walk (the include rule's recipe): only a SymbolicLink",
    "        # counts, at most 40 hops, fail closed on an unusable target, and where",
    "        # / is the separator a backslash in a target is a filename character.",
    "        $ssRef0 = Join-Path (Join-Path $HOME_DIR '.claude') $ssRel",
    "        $ssSrc = $ssRef0",
    "        $ssHops = 0",
    "        $ssBroken = $false",
    "        $ssBslash = $false",
    "        while ($true) {",
    "          $it = Get-Item -LiteralPath $ssSrc -Force -ErrorAction SilentlyContinue",
    "          if ($null -eq $it) { if (Test-Path -LiteralPath $ssSrc) { $ssBroken = $true }; break }",
    "          if ($it.LinkType -ne 'SymbolicLink') { break }",
    "          if ($ssHops -ge 40) { $ssBroken = $true; break }",
    "          $tg = @($it.Target)",
    "          if ($tg.Count -eq 0 -or -not $tg[0]) { $ssBroken = $true; break }",
    "          $ilt = [string]$tg[0]",
    "          $tn = $ilt.Replace([IO.Path]::DirectorySeparatorChar, '/')",
    "          if ($tn -eq '.' -or $tn -eq '..' -or $tn.EndsWith('/') -or $tn.EndsWith('/.') -or $tn.EndsWith('/..')) { $ssBroken = $true; break }",
    "          if ([IO.Path]::DirectorySeparatorChar -eq '/' -and $ilt.Contains('\\')) { $ssBslash = $true; break }",
    "          if (-not [IO.Path]::IsPathRooted($ilt)) { $ilt = Join-Path (Split-Path -Parent $ssSrc) $ilt }",
    "          $ssSrc = $ilt",
    "          $ssHops = $ssHops + 1",
    "        }",
    `        if ($ssBslash) { ${omit(r.linkTargetNotScript)}; continue }`,
    "        # PM ruling B1 (#4172's rule): a link chain with a credential-bearing part in",
    "        # a link's name or target text, or in its physical path, is refused; one",
    "        # whose walk reaches /proc could not be checked.",
    "        $ssPhys = $null",
    "        if ($ssHops -gt 0) {",
    "          $ssPhys = physicalPath $ssRef0",
    "          $ssCred = $script:ppCred",
    "          $ssProc = $script:ppProc",
    `          if ($ssCred -or ($ssPhys -and (hasCredentialPart $ssPhys))) { ${omit(r.linkThroughCredential)}; continue }`,
    `          if ($ssProc) { ${omit(r.linkUnchecked)}; continue }`,
    "        }",
    `        if ($ssBroken) { ${omit(r.notRegularFile)}; continue }`,
    `        if (-not (Test-Path -LiteralPath $ssSrc)) { ${omit(r.notFound)}; continue }`,
    `        if (-not (Test-Path -LiteralPath $ssSrc -PathType Leaf)) { ${omit(r.notRegularFile)}; continue }`,
    "        if ($ssHops -gt 0) {",
    `          if (-not [regex]::IsMatch((Split-Path -Leaf $ssSrc), $ssNamePat)) { ${omit(r.linkTargetNotScript)}; continue }`,
    "          # A linked script whose physical path could not be read is not carried.",
    `          if (-not $ssPhys) { ${omit(r.linkUnchecked)}; continue }`,
    "        }",
    "        # D2: a script that holds a known credential token is not carried (the",
    "        # match is never printed). Latin-1 reads raw bytes, as bash's grep does;",
    "        # ReadAllText's default would decode a UTF-16 byte-order mark.",
    "        $ssText = $null",
    "        try { $ssText = [IO.File]::ReadAllText($ssSrc, [Text.Encoding]::GetEncoding(28591)) } catch { $ssText = $null }",
    `        if ($null -eq $ssText) { ${omit(r.unreadable)}; continue }`,
    `        if ([regex]::IsMatch($ssText, $ssCredPat)) { ${omit(r.looksLikeCredential)}; continue }`,
    `        $ssDir = Join-Path $STAGING ${psq(SETTINGS_SCRIPTS_DIR)}`,
    "        if (-not (Test-Path -LiteralPath $ssDir)) { New-Item -ItemType Directory -Force -Path $ssDir | Out-Null }",
    "        Copy-Item -LiteralPath $ssSrc -Destination (Join-Path $ssDir $ssRel) -Force",
    "        [void]$ssCarried.Add($ssRel)",
    `        $SETTINGS_SCRIPTS += ([ordered]@{ path = ${psq(`${SETTINGS_SCRIPTS_DIR}/`)} + $ssRel })`,
    "      }",
    "    }",
  ];
}
