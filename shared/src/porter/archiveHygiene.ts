// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — the archive hygiene gate (issue #4373, R5).
 *
 * An archive copied off a machine cannot be recalled, so every Porter archive
 * is checked before its path is printed or it is uploaded: by BOTH generated
 * export scripts as their last step (bash and PowerShell, from the rules
 * below), by `scripts/verify-porter-archive-hygiene-v1.sh` (the operator and CI
 * form, which embeds the SAME bash lines), and, for premium descriptors, by the
 * importer as a backstop. `scripts/verify-porter-secret-hygiene.sh` is a
 * different tool: it scans the source machine's TRANSCRIPTS for secrets that
 * passed through the model, not an archive.
 *
 * Three rule kinds, each a canonical regex source that reads the same in
 * `grep -E` (GNU and BSD) and .NET:
 *  - PATH rules run on every member name (`tar -tzf`): payload that no
 *    definitions-only archive may carry (plugin trees, `.credentials.json`,
 *    `.claude.json`, a plaintext `secrets.json` member, a transcript, a
 *    credential-bearing name, a premium marketplace folder).
 *  - CONTENT rules run on the bytes of every extracted file: secret VALUE
 *    shapes (a known token prefix followed by a token-length body), never bare
 *    keywords, so a hook that holds a detection pattern such as `sk-ant-[A-Za-z0-9]`
 *    is not flagged.
 *  - The MANIFEST rule: an archive that says `profile: "tenant"` carries no
 *    premium plugin descriptor.
 *
 * NODE-FREE: rule data and string builders only.
 */
import {
  ARCHIVE_CREDENTIAL_NAMES,
  ARCHIVE_CREDENTIAL_PREFIXES,
} from "./manifest";
import { bashSingleQuote, psq } from "./exportShared";
import {
  PREMIUM_MARKETPLACE_NAMES,
  PREMIUM_MARKETPLACE_SOURCE_PATTERN,
} from "./tenantProfile";

/** One hygiene rule: a stable id (printed on a hit) and a canonical regex source. */
export interface ArchiveHygieneRule {
  id: string;
  pattern: string;
  /** Match without regard to ASCII case. */
  ignoreCase?: boolean;
  /** A hit whose matched text contains this is a documented example, not a secret. */
  except?: string;
  /** A member name matching this (same case rule) is exempt from a PATH rule. */
  unless?: string;
}

/**
 * A literal for a regex source: every ERE metacharacter escaped, and nothing
 * else (GNU grep 3.8+ warns on a stray backslash before `-` or `/`).
 */
function reLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The credential-bearing names (any case) as one path-part alternation. */
function credentialNameAlternation(): string {
  return [
    ...ARCHIVE_CREDENTIAL_NAMES.map(reLiteral),
    ...ARCHIVE_CREDENTIAL_PREFIXES.map(p => reLiteral(p) + "[^/]*"),
  ].join("|");
}

/** Rules on archive member NAMES (`tar -tzf` lines; a folder ends in `/`). */
export const ARCHIVE_PATH_RULES: readonly ArchiveHygieneRule[] = [
  { id: "plugin-payload", pattern: "^(\\./)?plugins/" },
  {
    id: "plugin-payload",
    pattern: "(^|/)plugins/(cache|marketplaces|repos)/",
  },
  { id: "credentials-file", pattern: "(^|/)\\.credentials\\.json$" },
  { id: "host-config", pattern: "(^|/)\\.claude\\.json$" },
  { id: "plaintext-secrets", pattern: "^(\\./)?secrets\\.json$" },
  { id: "transcript", pattern: "(^|/)projects/[^/]+/[^/]+\\.jsonl$" },
  {
    id: "credential-name",
    pattern: `(^|/)(${credentialNameAlternation()})(/|$)`,
    ignoreCase: true,
    // A CLAUDE.md include is governed by its own rule (#4143/#4172): an honest
    // `@.env.md` include ships as claude-includes/.env.md and keeps importing.
    // Its folders never start with a dot (#4143), so `.ssh/` stays flagged.
    unless: "^(\\./)?claude-includes/([^/.][^/]*/)*[^/]+\\.md$",
  },
  {
    id: "premium-pack",
    pattern: `(^|/)(${PREMIUM_MARKETPLACE_NAMES.map(reLiteral).join("|")})(/|$)`,
  },
];

/**
 * Rules on file CONTENT: secret value shapes. Each needs a token-length body,
 * so a regex or a doc that names the prefix alone does not match.
 */
export const ARCHIVE_CONTENT_RULES: readonly ArchiveHygieneRule[] = [
  { id: "github-token", pattern: "gh[opsur]_[A-Za-z0-9]{36,}" },
  { id: "github-pat", pattern: "github_pat_[A-Za-z0-9_]{40,}" },
  { id: "anthropic-key", pattern: "sk-ant-[A-Za-z0-9_-]{32,}" },
  {
    id: "openai-key",
    pattern:
      "(^|[^A-Za-z0-9_-])sk-([A-Za-z0-9]{32,}|(proj|svcacct|admin)-[A-Za-z0-9_-]{32,})",
  },
  {
    id: "aws-access-key",
    pattern: "(^|[^A-Za-z0-9])(AKIA|ASIA)[0-9A-Z]{16}([^A-Za-z0-9]|$)",
    // AWS's own documentation example, AKIAIOSFODNN7EXAMPLE.
    except: "EXAMPLE",
  },
  { id: "slack-token", pattern: "xox[baprs]-[0-9]+-[A-Za-z0-9-]{10,}" },
  // An age (X25519) identity, and its post-quantum variant. The id avoids the
  // word the definitions-only invariant forbids in the scripts' code (no `age`
  // command, #3245), and `[Y]` keeps the identity prefix itself out of the
  // generated scripts, which the #2342 R1 guard checks never carry it.
  {
    id: "x25519-secret-key",
    pattern: "AGE-SECRET-KE[Y]-(PQ-)?1[0-9A-Z]{58}",
  },
  {
    id: "jwt",
    pattern:
      "eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
  },
  { id: "private-key", pattern: "-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----" },
];

/** The manifest rule's id: a tenant archive that names a premium plugin. */
export const ARCHIVE_PREMIUM_DESCRIPTOR_RULE = "premium-descriptor";

/** The ids every hit can carry (the docs and the tests list them). */
export const ARCHIVE_HYGIENE_RULE_IDS: readonly string[] = [
  ...new Set([
    ...ARCHIVE_PATH_RULES.map(r => r.id),
    ...ARCHIVE_CONTENT_RULES.map(r => r.id),
    ARCHIVE_PREMIUM_DESCRIPTOR_RULE,
  ]),
];

/**
 * The jq program for the manifest rule: true when a `tenant` manifest names a
 * premium marketplace (by plugin descriptor, marketplace name, or source).
 * Takes `$n` (the names, a JSON array) and `$s` (the source pattern).
 */
export function premiumDescriptorJq(): string {
  return [
    '((.profile // "full") == "tenant") and (',
    "  ([.plugins.plugins[]?.marketplace] | any(. as $m | $n | any(. == $m)))",
    '  or ([.plugins.marketplaces[]?] | any((.name as $m | $n | any(. == $m)) or ((.source // "") | test($s; "i"))))',
    ")",
  ].join("\n");
}

/**
 * The bash function `porter_archive_hygiene <archive.tar.gz> <empty scratch
 * folder>`: prints one `<rule id><TAB><member>` line per hit, and returns 0
 * when the archive is clean, 1 on any hit, 2 when it cannot be listed or
 * extracted. Needs tar, gzip, grep and jq. Safe under `set -eu` and
 * `set -o pipefail` (every grep runs in an `if`, and no pipe stops early).
 * Both the bash exporter and `scripts/verify-porter-archive-hygiene-v1.sh` run
 * these exact lines; a test pins the script's copy to this output.
 */
export function archiveHygieneShellLines(): string[] {
  const lines: string[] = [
    "porter_archive_hygiene() { # $1 = archive (.tar.gz), $2 = an empty scratch folder; prints <rule>TAB<member> per hit; returns 0 clean, 1 hit, 2 unreadable",
    '  _hd="$2"; _hh=0',
    '  tar -tzf "$1" > "$_hd/members.txt" 2>/dev/null || return 2',
    '  mkdir -p "$_hd/x"',
    '  tar -xzf "$1" -C "$_hd/x" 2>/dev/null || return 2',
  ];
  for (const r of ARCHIVE_PATH_RULES) {
    const flags = r.ignoreCase ? "-iE" : "-E";
    const unless =
      r.unless !== undefined
        ? ` | grep -v${r.ignoreCase ? "i" : ""}E -e ${bashSingleQuote(r.unless)}`
        : "";
    lines.push(
      `  if grep ${flags} -e ${bashSingleQuote(r.pattern)} "$_hd/members.txt"${unless} > "$_hd/hits.txt" 2>/dev/null; then`,
      `    while IFS= read -r _hm; do printf '%s\\t%s\\n' ${bashSingleQuote(r.id)} "$_hm"; done < "$_hd/hits.txt"; _hh=1`,
      "  fi"
    );
  }
  for (const r of ARCHIVE_CONTENT_RULES) {
    lines.push(
      `  if grep -rlaE -e ${bashSingleQuote(r.pattern)} "$_hd/x" > "$_hd/hits.txt" 2>/dev/null; then`,
      "    while IFS= read -r _hf; do"
    );
    if (r.except !== undefined) {
      lines.push(
        `      grep -aoE -e ${bashSingleQuote(r.pattern)} "$_hf" | grep -v -e ${bashSingleQuote(r.except)} > /dev/null || continue`
      );
    }
    lines.push(
      `      printf '%s\\t%s\\n' ${bashSingleQuote(r.id)} "\${_hf#"$_hd"/x/}"; _hh=1`,
      '    done < "$_hd/hits.txt"',
      "  fi"
    );
  }
  lines.push(
    '  if [ -f "$_hd/x/manifest.json" ] && jq -e \\',
    `    --argjson n ${bashSingleQuote(JSON.stringify(PREMIUM_MARKETPLACE_NAMES))} --arg s ${bashSingleQuote(PREMIUM_MARKETPLACE_SOURCE_PATTERN)} \\`,
    `    ${bashSingleQuote(premiumDescriptorJq())} "$_hd/x/manifest.json" > /dev/null 2>&1; then`,
    `    printf '%s\\t%s\\n' ${bashSingleQuote(ARCHIVE_PREMIUM_DESCRIPTOR_RULE)} manifest.json; _hh=1`,
    "  fi",
    '  return "$_hh"',
    "}"
  );
  return lines;
}

/**
 * The PowerShell twin, `porterArchiveHygiene($archive, $scratch)`, for a caller
 * with `$TAR` in scope: returns one `<rule id><TAB><member>` string per hit
 * (empty when clean) and throws when the archive cannot be listed or
 * extracted. File bytes are read as ISO-8859-1, so every byte is one character
 * and a match never depends on the file's encoding; `^`/`$` match at line ends,
 * as grep's do.
 */
export function archiveHygienePowerShellLines(): string[] {
  const reOf = (pattern: string, ignoreCase?: boolean): string =>
    `[regex]::new(${psq(pattern)}, [System.Text.RegularExpressions.RegexOptions]'Multiline${ignoreCase ? ", IgnoreCase" : ""}')`;
  const re = (r: ArchiveHygieneRule): string => reOf(r.pattern, r.ignoreCase);
  const ruleTable = (rules: readonly ArchiveHygieneRule[]): string =>
    "@(" +
    rules
      .map(
        r =>
          `@{ id = ${psq(r.id)}; re = ${re(r)}; except = ${
            r.except !== undefined ? psq(r.except) : "$null"
          }; unless = ${
            r.unless !== undefined ? reOf(r.unless, r.ignoreCase) : "$null"
          } }`
      )
      .join(", ") +
    ")";
  return [
    "    function porterArchiveHygiene($archive, $scratch) {",
    "      $hits = New-Object 'System.Collections.Generic.List[string]'",
    "      $members = @(& $TAR @('-tzf', $archive))",
    "      if ($LASTEXITCODE -ne 0) { throw 'porter: the hygiene check could not list the archive' }",
    "      $xdir = Join-Path $scratch 'x'",
    "      New-Item -ItemType Directory -Force -Path $xdir | Out-Null",
    "      & $TAR @('-xzf', $archive, '-C', $xdir)",
    "      if ($LASTEXITCODE -ne 0) { throw 'porter: the hygiene check could not extract the archive' }",
    `      $pathRules = ${ruleTable(ARCHIVE_PATH_RULES)}`,
    `      $contentRules = ${ruleTable(ARCHIVE_CONTENT_RULES)}`,
    "      foreach ($r in $pathRules) {",
    '        foreach ($m in $members) { if ($r.re.IsMatch([string]$m) -and -not ($r.unless -and $r.unless.IsMatch([string]$m))) { $hits.Add($r.id + "`t" + $m) } }',
    "      }",
    "      $latin1 = [Text.Encoding]::GetEncoding(28591)",
    "      $xfull = [IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($xdir))",
    "      $files = @(Get-ChildItem -LiteralPath $xfull -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })",
    "      foreach ($f in $files) {",
    "        $text = $latin1.GetString([IO.File]::ReadAllBytes($f.FullName))",
    "        $rel = $f.FullName.Substring($xfull.Length).TrimStart('\\', '/') -replace '\\\\', '/'",
    "        foreach ($r in $contentRules) {",
    "          $found = $false",
    "          foreach ($mt in $r.re.Matches($text)) { if (($null -eq $r.except) -or -not $mt.Value.Contains($r.except)) { $found = $true; break } }",
    '          if ($found) { $hits.Add($r.id + "`t" + $rel) }',
    "        }",
    "      }",
    "      $mpath = Join-Path $xdir 'manifest.json'",
    "      if (Test-Path -LiteralPath $mpath -PathType Leaf) {",
    "        $mj = Get-Content -Raw -Encoding UTF8 -LiteralPath $mpath | ConvertFrom-Json",
    `        $premNames = ${"@(" + PREMIUM_MARKETPLACE_NAMES.map(psq).join(", ") + ")"}`,
    `        $premSource = [regex]::new(${psq(PREMIUM_MARKETPLACE_SOURCE_PATTERN)}, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)`,
    "        $mprof = propOrNull $mj 'profile'",
    "        $mplug = propOrNull $mj 'plugins'",
    "        if (($mprof -eq 'tenant') -and $mplug) {",
    "          $prem = $false",
    "          foreach ($p in @(propOrNull $mplug 'plugins')) { if ($p -and ($premNames -ccontains [string](propOrNull $p 'marketplace'))) { $prem = $true } }",
    "          foreach ($mk in @(propOrNull $mplug 'marketplaces')) {",
    "            if (-not $mk) { continue }",
    "            if ($premNames -ccontains [string](propOrNull $mk 'name')) { $prem = $true }",
    "            $msrc = propOrNull $mk 'source'",
    "            if (($msrc -is [string]) -and $premSource.IsMatch($msrc)) { $prem = $true }",
    "          }",
    `          if ($prem) { $hits.Add(${psq(ARCHIVE_PREMIUM_DESCRIPTOR_RULE)} + "\`tmanifest.json") }`,
    "        }",
    "      }",
    "      return $hits.ToArray()",
    "    }",
  ];
}
