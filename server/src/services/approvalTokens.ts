// SPDX-License-Identifier: AGPL-3.0-only
/**
 * USER-APPROVAL nonce-token mint / verify / consume service (issue #3331, epic
 * #3329 Sub-Issue B — the authoritative server-side approval-verification path).
 *
 * Implements the token contract owned by rp1-home#1749's registry
 * (`~/.claude/skills/_shared/token-conventions.md`, schema 1.0.0). The registry
 * is a cross-repo CONTRACT, not a package — the server (this file) and the
 * hook-side fallback (`user-approval-mint-fallback.py`, rp1-home#1750) implement
 * AGAINST the same grammar, storage literals, 9-field schema, and rejection
 * vocabulary. A wrong literal here makes the server's writes invisible to the
 * consuming gates (rp1-home#1751/#1752), so every literal below is sourced from
 * the registry, never invented.
 *
 * Trust boundary (registry §5): channel-origin (a user-role message on a
 * channel-authenticated path), NOT token secrecy. The nonce is an
 * intent-confirmation carrier, never a credential; file existence is NEVER
 * trusted as approval (this service always re-verifies nonce + provenance +
 * single-use state + state-binding).
 *
 * Purity: every function takes an explicit absolute `repoPath` and any config is
 * INJECTED — the service reads no `process.env` and never guesses a cwd (the
 * `services/` convention, and #3332's engine signature `(repoPath, ...)`
 * requires it).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomInt } from "node:crypto";
import {
  isValid,
  mintFingerprint,
  runGit,
  type GateRecord,
  type IsValidOptions,
  type OverlapAnalysis,
  type StateFingerprint,
} from "./stateBinding";
import type { ApprovalTokensConfig } from "../config/approvalTokensConfig";

// ── Registry grammar (token-conventions.md §1) ──────────────────────────────

/**
 * Canonical 32-symbol alphabet `[A-HJ-NP-Z2-9]` (registry §1.2, ruling D1a):
 * `A-H J-N P-Z 2-9` — excludes the visually-ambiguous `0 1 I O`, RETAINS `L U`.
 * Exactly 32 symbols → 40 bits at 8 payload chars (the ≥40-bit floor).
 */
const NONCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * GENERATION / detection regex (registry §1.4). A minter generates ONLY from the
 * canonical 32-symbol class; a new detector compiles this. Anchored nowhere so it
 * matches a token embedded in prose.
 */
export const USER_APPROVAL_TOKEN_REGEX =
  /USER-APPROVAL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/;

/**
 * LEGACY acceptor regex (registry §1.4) — valid for VALIDATION only, never
 * generation. `[A-HJ-NP-Z2-9]` ⊂ `[A-Z2-9]`, so this looser superset accepts
 * every canonical token; the service validates with it so an already-deployed
 * matcher of the looser form stays a correct acceptor.
 */
export const USER_APPROVAL_ACCEPT_REGEX =
  /USER-APPROVAL-[A-Z2-9]{4}-[A-Z2-9]{4}/;

/** Extract the first USER-APPROVAL token in `text` (acceptor form), or null. */
export function extractToken(text: string): string | null {
  const m = text.match(USER_APPROVAL_ACCEPT_REGEX);
  return m ? m[0] : null;
}

/** Generate a canonical `USER-APPROVAL-XXXX-XXXX` nonce (registry §1). */
export function generateNonce(): string {
  const group = () =>
    Array.from(
      { length: 4 },
      () => NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)]
    ).join("");
  return `USER-APPROVAL-${group()}-${group()}`;
}

// ── Registry schema (token-conventions.md §4 — nine fields, snake_case) ──────

/** The rejection vocabulary (registry §5.3 — an OPEN convention, not a closed
 *  enum; consumers must tolerate a non-enum reason string). */
export type RejectionReason =
  | "nonce-mismatch"
  | "state-drift"
  | "provenance-rejected"
  | "replayed";

/** A minted challenge — six of the nine registry fields (§4.1). */
export interface ApprovalChallenge {
  nonce: string;
  action: string;
  scope: string;
  /** #3332's reconciled 5-field fingerprint (registry §4.2) — carried verbatim. */
  state_binding: StateFingerprint;
  /** ISO-8601 UTC, SECOND precision. Freshness derives from this CONTENT value,
   *  NEVER from file mtime (registry §4.1). */
  minted_at: string;
  single_use: boolean;
}

/** A grant — the challenge fields plus the three grant-only fields (§4.1). */
export interface ApprovalGrant extends ApprovalChallenge {
  /** Fleet identity (audit metadata, NOT an auth factor — registry §5.1). */
  approved_by: string;
  /** Channel origin (registry §4.1 vocabulary): `web-user(<uid>)` | `cli-api` |
   *  `federation` | `bare-terminal`. */
  origin: string;
  /** Grant flavor discriminator (registry §4.1). The server always mints
   *  `nonce`; the phrase branch is the hook-side legacy path. */
  mint_kind: "nonce" | "phrase";
}

/** Origin passed IN to `verifyToken` from the message pipeline (the structured
 *  companion `meta.origin`, ruling D6(a)). The grant's flat `origin` string is
 *  derived from it. */
export interface VerifyOrigin {
  class: "web-user" | "cli-api" | "federation" | "bare-terminal";
  /** Numeric owner id (web-user) — carried into the grant's `origin` string. */
  uid?: number;
  /** The SENDER's session id (cli-api) — the R3 self-send discriminator. */
  sessionId?: string;
}

/**
 * A resolved approval key (#3538). An issue-scoped match carries the numeric
 * issue; a bypass-scope match carries only its free-form scope-key (it has NO
 * issue number and no `claudedocs/.user-approval-granted-<N>.json`). #3563's mint
 * record keys on this union — Land-order contract 2 (epic #3329).
 */
export type ApprovalKey =
  | { kind: "issue"; issueNumber: number }
  | { kind: "scope"; scopeKey: string };

/** Human label for an {@link ApprovalKey} — used in the hook's log lines and the
 *  overlap decision menu. */
export function describeKey(key: ApprovalKey): string {
  return key.kind === "issue"
    ? `issue #${key.issueNumber}`
    : `scope ${key.scopeKey}`;
}

/** `verifyToken`'s outcome. `overlap` is the decision-menu flow (ruling D1a),
 *  NOT a denial — the caller surfaces the analysis and mints NO grant.
 *  `already-granted` (#3559 R1) is a re-sent token whose grant is already on disk
 *  (minted but NOT gate-consumed): an idempotent RESUME, never a replay — the
 *  caller DELIVERS + posts a non-denial notice and mints NOTHING. The `denied`
 *  arm carries an optional `issueNumber`/`at` so a ledger-confirmed `replayed`
 *  can render `#N` + the consumption instant in the #3579 catalogue copy. */
export type VerifyResult =
  | { ok: "granted"; key: ApprovalKey; grant: ApprovalGrant }
  | { ok: "already-granted"; key: ApprovalKey; grant: ApprovalGrant }
  | {
      ok: "denied";
      reason: RejectionReason | string;
      /** Present on `replayed` — the issue the consumed nonce approved (ledger row). */
      issueNumber?: number;
      /** Present on `replayed` — the ISO instant the nonce was consumed (ledger `ts`). */
      at?: string;
    }
  | { ok: "overlap"; key: ApprovalKey; analysis: OverlapAnalysis };

// ── APPROVAL_PROVENANCE comment formatter (#3653 — server half of epic #3329
//    ruling D6a Task 6) ───────────────────────────────────────────────────────
//
// A PURE re-implementation of the canonical schema authority
// `~/.claude/hooks/lib/approval_provenance.py::format_provenance_comment`,
// byte-for-byte for ASCII payloads. The server ships to cloud VMs where that
// rp1-home Python module is ABSENT, so shelling it is not an option — the
// registry sanctions "the server (TypeScript) … implement AGAINST the same
// grammar". Pinned by a parity test (approvalTokens.test.ts). Schema source:
// `_shared/approval-provenance-common.md` + `_shared/token-conventions.md` §4 —
// never invent a literal. Kept in this pure module (no I/O, no process.env); the
// impure POST of the rendered body lives in the hook (approvalTokenHook.ts).

/** APPROVAL_PROVENANCE schema version (approval_provenance.py SCHEMA_VERSION). */
const PROVENANCE_SCHEMA_VERSION = "1.0.0";
/** The HTML-comment envelope marker (approval_provenance.py MARKER). */
const PROVENANCE_MARKER = "APPROVAL_PROVENANCE";

/** The valid provenance scopes (approval_provenance.py VALID_SCOPES). */
export type ProvenanceScope = "issue" | "epic" | "repo";
const PROVENANCE_SCOPES: ReadonlySet<string> = new Set<string>([
  "issue",
  "epic",
  "repo",
]);

/**
 * Coerce an arbitrary grant scope to a valid {@link ProvenanceScope}, defaulting
 * to `"issue"`. Mirrors the directive's `VALID_SCOPES.has(scope) ? scope
 * : "issue"`. Load-bearing: an epic-parent token approval carries
 * `scope: "epic"`, and an `issue`-scoped comment on a parent authorizes NO
 * member close (approval_provenance.py find_valid_provenance), so `"epic"` MUST
 * be preserved — hardcoding `"issue"` would break epic-batch token closes.
 */
export function coerceProvenanceScope(scope: string): ProvenanceScope {
  return PROVENANCE_SCOPES.has(scope) ? (scope as ProvenanceScope) : "issue";
}

/**
 * Render the canonical APPROVAL_PROVENANCE comment body — PURE.
 *
 * Byte-identical to `approval_provenance.py::format_provenance_comment` for
 * ASCII inputs (verified by the parity test). Two invariants make the bytes
 * match:
 *   1. The JSON envelope's key order (schema_version, approved_by, phrase,
 *      approved_at, scope, repo, issue) — `JSON.stringify(payload, null, 2)`
 *      preserves insertion order and is byte-identical to Python
 *      `json.dumps(indent=2)` for ASCII.
 *   2. No trailing newline (the Python function returns without one; its CLI's
 *      `print()` appends it — the parity test strips that single `\n`).
 * Non-ASCII caveat: Python escapes non-ASCII (`\uXXXX`) while JS does not. The
 * inputs here are ASCII by construction (the nonce alphabet is ASCII;
 * `approved_by` is the constant `matt-local`), so no escaping is needed.
 */
export function buildProvenanceComment(args: {
  approvedBy: string;
  phrase: string;
  approvedAt: string;
  scope: ProvenanceScope;
  repo: string;
  issue: number;
}): string {
  const { approvedBy, phrase, approvedAt, scope, repo, issue } = args;
  const issueNum = Math.trunc(issue);
  // Insertion order MUST match approval_provenance.py's payload dict exactly —
  // the byte-parity depends on it.
  const payload = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    approved_by: String(approvedBy),
    phrase: String(phrase),
    approved_at: String(approvedAt),
    scope,
    repo: String(repo),
    issue: issueNum,
  };
  const envelope = JSON.stringify(payload, null, 2);
  // Collapse whitespace in the human-readable phrase — Python
  // `" ".join(str(phrase).split())`.
  const phraseInline = String(phrase).split(/\s+/).filter(Boolean).join(" ");
  return (
    `<!-- ${PROVENANCE_MARKER}\n` +
    `${envelope}\n` +
    `-->\n` +
    `## :white_check_mark: Approval Provenance | ${approvedAt}\n` +
    `\n` +
    `**Approved by**: ${approvedBy} · **Phrase**: \`${phraseInline}\` · **Scope**: ${scope}\n` +
    `**Target**: ${repo}#${issueNum}\n` +
    `\n` +
    `*Durable AUDIT record (rp1-home#1317, epic #1315; audit-only since rp1-home#1950).\n` +
    `This comment does not authorize a close — only a USER-APPROVAL nonce grant does.*\n` +
    `\n` +
    `---\n` +
    `:clipboard: *issue-approval-detector • ${approvedAt}*`
  );
}

// ── Storage (token-conventions.md §4.4 — flat dotfiles, legacy grant literal) ─

const CLAUDEDOCS = "claudedocs";
const CHALLENGE_RE = /^\.approval-challenge-(\d+)\.json$/;
const GRANT_RE = /^\.user-approval-granted-(\d+)\.json$/;

/**
 * Machine-global bypass-scope store subdirs UNDER an injected `~/.claude/state`
 * base (#3538, registry §4.4). The base is resolved by the caller (Task 7) and
 * injected via `verifyToken` opts — never resolved via `homedir()` here, so the
 * service stays pure (R5).
 */
const GLOBAL_CHALLENGE_SUBDIR = "approval-challenges";
const GLOBAL_GRANT_SUBDIR = "approval-grants";

/**
 * The machine-global acceptance ledger filename (registry §4.4, rp1-home#1751).
 * A CONSUMING gate (closer-approval-gate / prod-merge-interceptor) appends one
 * JSON line per honored grant AS it deletes the grant, so a nonce that is
 * gone-from-disk yet present here was genuinely CONSUMED — the discriminator
 * #3559 R3 needs to tell `replayed` (consumed) from `nonce-mismatch` (unknown).
 * Lives directly under the injected `~/.claude/state` base (the SAME base #3538
 * resolves for bypass challenges/grants; never a second opt, R5).
 */
const GLOBAL_ACCEPTANCE_LEDGER = "approval-acceptance.jsonl";

/**
 * Scope-key challenge/grant filename REs for the global store. The capture group
 * is the free-form scope-key (e.g. `workflow-label-gate-42`, `epic-99`,
 * `prod-merge-<repo>`), NOT a numeric issue — DISTINCT from the numeric issue REs
 * above. Do NOT reuse the `(\d+)` REs for the global dir. (Which scope-keys are
 * actually consumable is decided by the `scope:"bypass"` guard in `verifyToken`,
 * not by these REs.)
 */
const SCOPE_KEY_CHALLENGE_RE = /^\.approval-challenge-(.+)\.json$/;
const SCOPE_KEY_GRANT_RE = /^\.user-approval-granted-(.+)\.json$/;

/** Issue-scoped challenge path: `<repo>/claudedocs/.approval-challenge-<N>.json`. */
export function challengeFile(repoPath: string, issueNumber: number): string {
  return join(repoPath, CLAUDEDOCS, `.approval-challenge-${issueNumber}.json`);
}

/**
 * Issue-scoped grant path: `<repo>/claudedocs/.user-approval-granted-<N>.json`
 * — the LEGACY literal REUSED (registry §4.4, ruling D2a), discriminated by
 * `mint_kind`, NOT by a new filename. Reusing it keeps nonce grants inside the
 * existing anti-forge guard wall (`pm-clean-gate-approval-guard.py`) and
 * readable by the deployed gate's filename filter with NO gate-side path change.
 */
export function grantFile(repoPath: string, issueNumber: number): string {
  return join(
    repoPath,
    CLAUDEDOCS,
    `.user-approval-granted-${issueNumber}.json`
  );
}

/** ISO-8601 UTC at SECOND precision (registry §4.1 `minted_at`). */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Atomic JSON write (tmp + rename, mode 0600) — matches `accountService.ts`. */
function writeJsonAtomic(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Read the challenge for a specific issue (or null). */
export function readChallenge(
  repoPath: string,
  issueNumber: number
): ApprovalChallenge | null {
  return readJson<ApprovalChallenge>(challengeFile(repoPath, issueNumber));
}

/** Read the grant for a specific issue (or null). */
export function readGrant(
  repoPath: string,
  issueNumber: number
): ApprovalGrant | null {
  return readJson<ApprovalGrant>(grantFile(repoPath, issueNumber));
}

// ── Machine-global bypass-scope store (#3538, registry §4.4) ────────────────
// `stateDir` is the injected absolute `~/.claude/state` BASE path (Task 7); the
// service never resolves it (R5). Exported because #3563 consumes
// `readGlobalGrant`/`globalGrantFile` from OUTSIDE this module (its orphan probe
// re-checks a bypass grant and does NOT modify this file).

/** Global bypass-scope challenge dir: `<stateDir>/approval-challenges/`. */
export function globalChallengeDir(stateDir: string): string {
  return join(stateDir, GLOBAL_CHALLENGE_SUBDIR);
}

/** Global bypass-scope grant dir: `<stateDir>/approval-grants/`. */
export function globalGrantDir(stateDir: string): string {
  return join(stateDir, GLOBAL_GRANT_SUBDIR);
}

/** Global challenge path: `<stateDir>/approval-challenges/.approval-challenge-<scopeKey>.json`. */
export function globalChallengeFile(
  stateDir: string,
  scopeKey: string
): string {
  return join(
    globalChallengeDir(stateDir),
    `.approval-challenge-${scopeKey}.json`
  );
}

/** Global grant path: `<stateDir>/approval-grants/.user-approval-granted-<scopeKey>.json`. */
export function globalGrantFile(stateDir: string, scopeKey: string): string {
  return join(
    globalGrantDir(stateDir),
    `.user-approval-granted-${scopeKey}.json`
  );
}

/** Read the global bypass-scope grant for `scopeKey` (or null). */
export function readGlobalGrant(
  stateDir: string,
  scopeKey: string
): ApprovalGrant | null {
  return readJson<ApprovalGrant>(globalGrantFile(stateDir, scopeKey));
}

/** A tolerant acceptance-ledger hit (#3559 R3). Both fields are optional — the
 *  ledger's row shape is not uniform (see {@link scanAcceptanceLedger}). */
export interface AcceptanceLedgerHit {
  /** The row's `issue` validated as an integer, or undefined (`""` / non-integer). */
  issueNumber?: number;
  /** The row's `ts` (ISO consumption instant), present only if a non-empty string. */
  at?: string;
}

/**
 * Read-only, TOLERANT scan of the acceptance ledger by exact non-empty `nonce`
 * (#3559 R3, registry §4.4). The row shape is NOT uniform: the Python closer
 * writes 7 fields incl. `nonce` (`approval_dual_accept.py`), the shell gate
 * writes 6 with NO `nonce` (`check-approval-sentinel.sh`), and phrase accepts
 * write `nonce: ""`. So:
 *   - an empty/absent `nonce` NEVER matches (a 6-field or phrase row is skipped);
 *   - match on an exact non-empty `nonce`, take the LAST matching row (append order);
 *   - `issue` is a STRING that may be `""` — validate as an integer or OMIT it,
 *     never emit `NaN`;
 *   - pass `ts` through as-is (an ISO instant written by the Python closer).
 * A missing / unreadable / malformed ledger, or no match, returns `null` — the
 * caller maps that to `nonce-mismatch` (fail-soft: NEVER a false "already used").
 * Reads only (no mint / consume / write); the state base is INJECTED (R5).
 */
export function scanAcceptanceLedger(
  stateDir: string,
  nonce: string
): AcceptanceLedgerHit | null {
  if (!nonce) return null; // an empty nonce never matches (registry §4.4)
  let content: string;
  try {
    content = readFileSync(join(stateDir, GLOBAL_ACCEPTANCE_LEDGER), "utf8");
  } catch {
    return null; // absent / unreadable → fail-soft
  }
  let hit: AcceptanceLedgerHit | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // a malformed line is skipped, never fatal
    }
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const rowNonce = typeof r.nonce === "string" ? r.nonce : "";
    if (!rowNonce || rowNonce !== nonce) continue; // exact non-empty match only
    let issueNumber: number | undefined;
    if (typeof r.issue === "string" && r.issue.trim() !== "") {
      const n = Number(r.issue);
      if (Number.isInteger(n)) issueNumber = n;
    } else if (typeof r.issue === "number" && Number.isInteger(r.issue)) {
      issueNumber = r.issue;
    }
    const at =
      typeof r.ts === "string" && r.ts.trim() !== "" ? r.ts : undefined;
    hit = { issueNumber, at }; // LAST matching row wins (append order)
  }
  return hit;
}

/**
 * Scan an arbitrary `dir` for a challenge/grant whose `nonce` matches `token`,
 * returning the filename-RE capture group verbatim as `key`. The token does not
 * encode its own key, so the record is located by nonce. A malformed file is
 * skipped (never throws); a MISSING dir is a clean miss (`readdirSync` catch →
 * null), so a not-yet-created global store returns `null`, never a throw (#3538).
 */
function scanDirByNonce<T extends ApprovalChallenge>(
  dir: string,
  token: string,
  fileRe: RegExp
): { key: string; record: T } | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = name.match(fileRe);
    if (!m) continue;
    const record = readJson<T>(join(dir, name));
    if (record && record.nonce === token) {
      return { key: m[1], record };
    }
  }
  return null;
}

/**
 * Scan `<repo>/claudedocs/` for a challenge/grant whose `nonce` matches `token`.
 * Thin wrapper over {@link scanDirByNonce} that maps the numeric filename capture
 * back to `issueNumber` — byte-identical to the pre-#3538 behavior.
 */
function scanByNonce<T extends ApprovalChallenge>(
  repoPath: string,
  token: string,
  fileRe: RegExp
): { issueNumber: number; record: T } | null {
  const hit = scanDirByNonce<T>(join(repoPath, CLAUDEDOCS), token, fileRe);
  return hit ? { issueNumber: Number(hit.key), record: hit.record } : null;
}

// ── Permission allowlist (R7 — inert while the flag is OFF) ──────────────────

/**
 * Actions permitted to mint a grant when the allowlist is ENFORCED. The set is
 * consulted ONLY when `config.allowlistEnabled` is true; while the flag is OFF
 * (the default), `checkAllowlist` returns "allow" for every action so the path
 * exists but is inert (R7).
 */
const APPROVAL_ACTION_ALLOWLIST: ReadonlySet<string> = new Set([
  "close-issue",
  "merge-pr",
  "prod-deploy",
  // #3619-A forward-compat seam (PM D4 ruling 2026-09-12): #3538 lands FIRST on
  // the shared `approvalTokenHook.ts` granted arm, so it pre-seeds the action
  // allowlist that #3619-A consumes. INERT for #3538's own behavior — prod-merge
  // records are `scope:"repo-independent"` (rejected by the global scope guard),
  // and a bypass match skips the action-NAME check entirely — so this admits no
  // new grant on any #3538 path; it only reserves the vocabulary for #3619-A.
  "prod-merge",
  "batch-approve",
  "bypass",
]);

/** R7 permission-allowlist check. Inert (always "allow") while the flag is OFF. */
export function checkAllowlist(
  action: string,
  config: ApprovalTokensConfig
): "allow" | "deny" {
  if (!config.allowlistEnabled) return "allow"; // R7: path exists, but inert
  return APPROVAL_ACTION_ALLOWLIST.has(action) ? "allow" : "deny";
}

// ── Mint / verify / consume ─────────────────────────────────────────────────

/**
 * Mint a challenge for `issueNumber`: capture the approved state via #3332's
 * `mintFingerprint`, write the six-field challenge record. The nonce is
 * generated canonically unless one is supplied (tests / re-surface).
 */
export async function writeChallenge(
  repoPath: string,
  args: {
    issueNumber: number;
    action: string;
    scope: string;
    /** Repo-relative paths whose state the approval binds (§4.2). */
    approvedPaths: string[];
    targetBranch: string;
    singleUse?: boolean;
    nonce?: string;
  }
): Promise<ApprovalChallenge> {
  const state_binding = await mintFingerprint(
    repoPath,
    args.approvedPaths,
    args.targetBranch
  );
  const challenge: ApprovalChallenge = {
    nonce: args.nonce ?? generateNonce(),
    action: args.action,
    scope: args.scope,
    state_binding,
    minted_at: nowIso(),
    single_use: args.singleUse ?? true,
  };
  writeJsonAtomic(challengeFile(repoPath, args.issueNumber), challenge);
  return challenge;
}

/** Format the flat grant `origin` string from the structured verify origin
 *  (registry §4.1 vocabulary). web-user carries its uid: `web-user(<uid>)`. */
function formatOrigin(origin: VerifyOrigin): string {
  if (origin.class === "web-user") {
    return origin.uid != null ? `web-user(${origin.uid})` : "web-user";
  }
  return origin.class; // cli-api | federation | bare-terminal
}

/**
 * Resolve the grant's `approved_by` (registry §5.1 — fleet identity, audit
 * metadata, NOT an auth factor). The server's JWT carries only a numeric owner
 * id + namespace, never a gh login, so we record the registry-sanctioned
 * `matt-local` fallback; the uid is preserved in `origin`. Resolving a real gh
 * login per-approval is future work (it is not an authentication factor).
 */
function resolveApprovedBy(_origin: VerifyOrigin): string {
  return "matt-local";
}

/**
 * Write the grant and CONSUME the challenge (single-use at mint, registry §4.4).
 * The grant reuses the legacy `.user-approval-granted-<N>.json` literal,
 * discriminated by `mint_kind: "nonce"`.
 */
export async function mintGrant(
  repoPath: string,
  issueNumber: number,
  challenge: ApprovalChallenge,
  origin: VerifyOrigin
): Promise<ApprovalGrant> {
  const grant: ApprovalGrant = {
    ...challenge,
    minted_at: nowIso(),
    approved_by: resolveApprovedBy(origin),
    origin: formatOrigin(origin),
    mint_kind: "nonce",
  };
  writeJsonAtomic(grantFile(repoPath, issueNumber), grant);
  // Consume the challenge at grant mint (registry §4.4 single-use).
  try {
    unlinkSync(challengeFile(repoPath, issueNumber));
  } catch {
    /* already gone — idempotent */
  }
  return grant;
}

/**
 * Mint a BYPASS-scope grant to the machine-global grant store and CONSUME the
 * global challenge (#3538, registry §4.4). The scope-key twin of {@link mintGrant},
 * keyed against the injected `~/.claude/state` base rather than a repo.
 *
 * CLAIM-FIRST commit order (rp1-home finding 1750-8): the bare-terminal minter
 * (`user-approval-mint-fallback.py`) shares this SAME global store and also
 * claims-then-writes, so a plain write-then-unlink would race it. We atomically
 * `renameSync` the challenge to a `.claimed-*` name BEFORE the grant write — the
 * rename is the single commit point. If the rename throws (ENOENT — a concurrent
 * consumer already claimed it), return `null` so the caller maps it to `replayed`.
 */
export async function mintGlobalGrant(
  stateDir: string,
  scopeKey: string,
  challenge: ApprovalChallenge,
  origin: VerifyOrigin
): Promise<ApprovalGrant | null> {
  const challengePath = globalChallengeFile(stateDir, scopeKey);
  const claimed = `${challengePath}.claimed-${process.pid}-${randomInt(
    0x10000000
  ).toString(16)}`;
  try {
    renameSync(challengePath, claimed);
  } catch {
    // Already claimed/consumed by a concurrent minter — treat as a replay.
    return null;
  }
  const grant: ApprovalGrant = {
    ...challenge,
    minted_at: nowIso(),
    approved_by: resolveApprovedBy(origin),
    origin: formatOrigin(origin),
    mint_kind: "nonce",
  };
  // The producer creates approval-grants/ with mode 0o700; the server may be the
  // FIRST writer, and writeJsonAtomic's mkdirSync sets no mode — so pre-create
  // with 0o700 for parity (approval_dual_accept.py:448).
  mkdirSync(globalGrantDir(stateDir), { recursive: true, mode: 0o700 });
  writeJsonAtomic(globalGrantFile(stateDir, scopeKey), grant);
  // Grant is now the record of truth — remove the claimed challenge.
  try {
    unlinkSync(claimed);
  } catch {
    /* already gone — idempotent */
  }
  return grant;
}

/**
 * Consume (delete) the grant — single-use consumption at GATE acceptance
 * (registry §4.4). Called by the downstream approval gate once it has honored
 * the grant. Returns true iff a grant file was removed.
 */
export function consumeGrant(repoPath: string, issueNumber: number): boolean {
  try {
    unlinkSync(grantFile(repoPath, issueNumber));
    return true;
  } catch {
    return false;
  }
}

/**
 * #3619 (D1-A): resolve the LIVE tip of origin/<devBranch>, the consumption side
 * of the prod-merge origin-ref binding. Returns the 40-hex tip, or an { error }
 * (fetch/rev-parse failed or timed out) so the caller denies with a surfaced
 * reason (never a silent block, never a false valid). Test-injectable, mirroring
 * stateBinding.TargetDriftResolver.
 */
export type OriginTipResolver = (input: {
  repoPath: string;
  devBranch: string;
}) => Promise<{ tip: string } | { error: string }>;

// #3619: prod-merge tip-fetch budget. Tighter than runGit's 30s default so the
// fetch denies WITHIN the 5s message-gate window (approvalTokenHook timeoutMs)
// with a specific reason rather than tripping the gate's fail-closed hard-deny.
// Env-overridable via HAPI_PROD_MERGE_TIP_TIMEOUT_MS.
const PROD_MERGE_TIP_TIMEOUT_MS = (() => {
  const raw = Number(process.env.HAPI_PROD_MERGE_TIP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
})();

/**
 * Production OriginTipResolver: git fetch origin <devBranch> then rev-parse
 * origin/<devBranch>, via the hardened runGit (SIGKILL timeout, scrubbed GIT_*
 * env, no-shallow). ANY failure (transient timeout OR a plain non-zero git exit,
 * e.g. missing credentials / unknown ref) maps to { error } so the caller denies
 * as indeterminate. Mirrors rp1-home prod_merge_binding.capture_origin_dev_tip.
 */
export async function defaultProdMergeTipResolver(input: {
  repoPath: string;
  devBranch: string;
}): Promise<{ tip: string } | { error: string }> {
  const { repoPath, devBranch } = input;
  try {
    await runGit(["fetch", "origin", devBranch], repoPath, {
      timeoutMs: PROD_MERGE_TIP_TIMEOUT_MS,
    });
    const { stdout } = await runGit(
      ["rev-parse", `origin/${devBranch}`],
      repoPath,
      { timeoutMs: PROD_MERGE_TIP_TIMEOUT_MS }
    );
    const tip = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(tip)) {
      return { error: `unexpected rev-parse output for origin/${devBranch}` };
    }
    return { tip };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** #3619 prod-merge origin-ref check outcome. drift -> #3331 state-drift;
 *  indeterminate -> conservative deny with a surfaced reason. */
type ProdMergeCheckResult =
  | { kind: "valid" }
  | { kind: "drift"; detail: string }
  | { kind: "indeterminate"; reason: string };

/**
 * #3619 (D1-A): TS port of rp1-home prod_merge_binding.verify_prod_merge_grant.
 * The grant mints ONLY while the live origin/<dev_branch> tip still equals the
 * head_sha the human approved (V4). The bespoke binding lives INSIDE the
 * challenge's state_binding: head_sha (the approved dev tip) plus a
 * prod-merge-local dev_branch hint (NOT declared on StateFingerprint; read via a
 * localized cast). A missing field, or a fetch/rev-parse failure, is
 * indeterminate (fail-closed), never a false valid.
 */
async function verifyProdMergeBinding(
  repoPath: string,
  binding: StateFingerprint,
  resolver: OriginTipResolver = defaultProdMergeTipResolver
): Promise<ProdMergeCheckResult> {
  const headAtMint = binding.head_sha;
  if (!headAtMint) {
    return {
      kind: "indeterminate",
      reason: "prod-merge binding has no head_sha",
    };
  }
  const devBranch = (binding as StateFingerprint & { dev_branch?: string })
    .dev_branch;
  if (!devBranch) {
    return {
      kind: "indeterminate",
      reason: "prod-merge binding has no dev_branch hint",
    };
  }
  const tip = await resolver({ repoPath, devBranch });
  if ("error" in tip) {
    return {
      kind: "indeterminate",
      reason: `could not capture origin/${devBranch} tip: ${tip.error}`,
    };
  }
  if (tip.tip === headAtMint) {
    return { kind: "valid" };
  }
  return {
    kind: "drift",
    detail: `origin/${devBranch} moved ${headAtMint.slice(0, 12)} -> ${tip.tip.slice(0, 12)} since mint`,
  };
}

/**
 * Verify an inbound `USER-APPROVAL-` token against the pending challenge and,
 * on success, mint a single-use grant recording `approved_by`. This is the
 * authoritative verification path (R1) — the message-hook gate calls it.
 *
 * Decision order (each returns a machine-readable reason on denial):
 *   1. locate the challenge by nonce — repo-local (`claudedocs/`) FIRST, then the
 *      injected machine-global bypass-scope store (#3538) as a fallback; a
 *      global match is consumable ONLY when `scope === "bypass"` (the
 *      security-load-bearing scope guard — `epic` / `repo-independent` records
 *      fall through). No usable challenge: a minted-but-UNCONSUMED grant with this
 *      nonce still on disk (repo-local OR global) → `already-granted` (idempotent
 *      RESUME, #3559 R1 — Land-order contract 2, re-align BOTH stores); else a
 *      consumed nonce in the acceptance ledger → `replayed` (with `#N` + `ts`);
 *      else → `nonce-mismatch`;
 *   2. a grant already carries the matched key's nonce → `already-granted`
 *      (idempotent RESUME, #3559 R1 — the near-dead re-surface path);
 *   3. no origin on the wire (drained queued token / federation skew) → `provenance-rejected`;
 *   4. self-send — a cli-api token from the session it gates → `provenance-rejected`;
 *   5. allowlist denies the action (only when the flag is ON; SKIPPED for a
 *      bypass match — `scope:"bypass"` IS the family's allowlist entry) → `provenance-rejected`;
 *   6. #3332 state-binding: issue-scope → crisp Layer-1/Layer-2; bypass → the
 *      hygiene-TTL clock (D4/A′, fingerprint-less). invalid → `state-drift`;
 *      indeterminate → conservative deny; overlap → the decision-menu flow (NO
 *      grant); valid → mint the grant (repo-local or global by key kind).
 */
export async function verifyToken(
  repoPath: string,
  token: string,
  opts: {
    /** The session RECEIVING the message (the gated session). */
    gatedSessionId: string;
    /** The structured provenance of the send (absent for a drained token). */
    origin?: VerifyOrigin;
    config: ApprovalTokensConfig;
    /**
     * The injected `~/.claude/state` BASE dir (#3538). When set, a repo-local
     * nonce miss falls back to the machine-global bypass-scope store
     * (`<base>/approval-challenges/`). When ABSENT, behavior is byte-identical to
     * the pre-#3538 repo-local-only path — backward compatible, keeps the pure
     * unit tests untouched. The service NEVER resolves this itself (R5).
     */
    globalStateDir?: string;
    /**
     * #3332 state-binding options (hygiene TTL + Layer-2 resolver / env
     * injection). In production the hook passes only `{ hygieneTtlDays }` and the
     * default gh-then-REST target-drift resolver runs; tests inject
     * `resolveTargetChanges` for a deterministic, network-free check.
     */
    stateBinding?: IsValidOptions;
    /**
     * #3619 (D1-A): origin-ref tip resolver for a hosted prod-merge
     * (`scope:"repo-independent"`) challenge. Absent in production ->
     * defaultProdMergeTipResolver runs the real git fetch + rev-parse
     * (deny-on-timeout); tests inject a deterministic tip.
     */
    prodMergeTip?: OriginTipResolver;
  }
): Promise<VerifyResult> {
  // 1. Locate the pending challenge by nonce — repo-local FIRST (R2).
  const localMatch = scanByNonce<ApprovalChallenge>(
    repoPath,
    token,
    CHALLENGE_RE
  );

  // On a repo-local miss, fall back to the machine-global bypass-scope store
  // (R1). The scope guard is SECURITY-LOAD-BEARING (registry §4.4, finding
  // 3538-8): the global dir also holds `scope:"epic"` batch challenges (Model A
  // consumption is deliberately UNBUILT server-side) and `scope:"repo-independent"`
  // prod-merge records whose bespoke origin-ref binding the generic engine cannot
  // verify — both MUST fall through untouched. Consume ONLY `scope:"bypass"`.
  // NEVER widen this to a denylist.
  const globalMatch =
    !localMatch && opts.globalStateDir
      ? scanDirByNonce<ApprovalChallenge>(
          globalChallengeDir(opts.globalStateDir),
          token,
          SCOPE_KEY_CHALLENGE_RE
        )
      : null;
  const usableGlobal =
    globalMatch && globalMatch.record.scope === "bypass" ? globalMatch : null;

  // #3619 (D1-A): a hosted /merge-dev-to-prod writes a machine-global
  // scope:"repo-independent" + action:"prod-merge" challenge that #3538's
  // scope guard leaves un-consumed (the GENERIC engine cannot verify its
  // bespoke origin-ref binding). This arm admits EXACTLY that record and
  // routes it to the TS origin-ref drift check (step 6), NOT the
  // fingerprint-less bypass path. Mutually exclusive with usableGlobal.
  const usableProdMerge =
    !localMatch &&
    !usableGlobal &&
    globalMatch &&
    globalMatch.record.scope === "repo-independent" &&
    globalMatch.record.action === "prod-merge"
      ? globalMatch
      : null;

  if (!localMatch && !usableGlobal && !usableProdMerge) {
    // No usable live challenge. A grant still on disk with this nonce — repo-local
    // (GRANT_RE) OR global (SCOPE_KEY_GRANT_RE) — is a minted-but-UNCONSUMED grant:
    // an idempotent RESUME (#3559 R1), NOT a replay. Capture the record + its store
    // so the caller delivers + resumes (mints nothing). Re-align BOTH stores
    // (Land-order contract 2) — mapping only the repo-local scan would leave
    // bypass-scope re-sends still saying `replayed`, keeping M3 alive for one store.
    const localGrant = scanByNonce<ApprovalGrant>(repoPath, token, GRANT_RE);
    if (localGrant) {
      return {
        ok: "already-granted",
        key: { kind: "issue", issueNumber: localGrant.issueNumber },
        grant: localGrant.record,
      };
    }
    const globalGrant =
      opts.globalStateDir != null
        ? scanDirByNonce<ApprovalGrant>(
            globalGrantDir(opts.globalStateDir),
            token,
            SCOPE_KEY_GRANT_RE
          )
        : null;
    if (globalGrant) {
      return {
        ok: "already-granted",
        key: { kind: "scope", scopeKey: globalGrant.key },
        grant: globalGrant.record,
      };
    }
    // No grant on disk → the nonce is either genuinely CONSUMED (recorded in the
    // acceptance ledger as the closer / prod-merge gate deleted the grant) or
    // unknown. A ledger hit → `replayed`, carrying the issue + the consumption
    // instant so #3579's catalogue renders "already used for #N at <ts>". No hit /
    // no ledger / unreadable → `nonce-mismatch` — fail-soft, never a false "already
    // used" (#3559 R3). The ledger lives under the injected state base.
    const consumed =
      opts.globalStateDir != null
        ? scanAcceptanceLedger(opts.globalStateDir, token)
        : null;
    if (consumed) {
      return {
        ok: "denied",
        reason: "replayed",
        ...(consumed.issueNumber != null
          ? { issueNumber: consumed.issueNumber }
          : {}),
        ...(consumed.at != null ? { at: consumed.at } : {}),
      };
    }
    return { ok: "denied", reason: "nonce-mismatch" };
  }

  // A global match is EITHER a bypass-scope record (usableGlobal) OR a
  // prod-merge record (usableProdMerge), never both (exclusive guards).
  const matchedGlobal = usableGlobal ?? usableProdMerge;
  const key: ApprovalKey = localMatch
    ? { kind: "issue", issueNumber: localMatch.issueNumber }
    : { kind: "scope", scopeKey: matchedGlobal!.key };
  const challenge = localMatch ? localMatch.record : matchedGlobal!.record;
  // #3619: isProdMerge takes the origin-ref drift check (step 6); isBypass
  // keeps the fingerprint-less hygiene-TTL path. Both are
  // key.kind === "scope", distinguished by WHICH guard matched.
  const isProdMerge = usableProdMerge != null;
  const isBypass = key.kind === "scope" && !isProdMerge;

  // 2. Idempotent RESUME (#3559 R1): a live challenge PLUS a grant carrying the
  //    same nonce means the grant was minted but not gate-consumed — deliver +
  //    resume, mint nothing (near-dead: `writeChallenge` has no non-test caller,
  //    but keep BOTH probe sites consistent — Land-order contract 3).
  //    (`opts.globalStateDir!` is non-null on the scope branch — `usableGlobal`
  //    required it above.)
  const existingGrant =
    key.kind === "issue"
      ? readGrant(repoPath, key.issueNumber)
      : readGlobalGrant(opts.globalStateDir!, key.scopeKey);
  if (existingGrant && existingGrant.nonce === challenge.nonce) {
    return { ok: "already-granted", key, grant: existingGrant };
  }

  // 3. Provenance floor: a token with no origin lost its channel identity — a
  //    drained queued token (Task 12b: the drain bypasses the authenticated
  //    route) OR a federation version-skew peer that dropped the field. Deny —
  //    never mint with an empty identity; the user re-approves live.
  if (!opts.origin) {
    return { ok: "denied", reason: "provenance-rejected" };
  }

  // 4. Self-send (R3): a cli-api token arriving FROM the session it gates. The
  //    header is self-reported, so this is accident / naive-injection proofing
  //    only (registry §5, documented NON-adversarial-proof).
  if (
    opts.origin.class === "cli-api" &&
    opts.origin.sessionId != null &&
    opts.origin.sessionId === opts.gatedSessionId
  ) {
    return { ok: "denied", reason: "provenance-rejected" };
  }

  // 5. Permission allowlist (R7) — inert while the flag is OFF. For a BYPASS
  //    match the action-NAME check is SKIPPED: `scope:"bypass"` IS the family's
  //    allowlist entry (ruled). The bypass action names (workflow-label-transition,
  //    apply-formatted-checkpoint, …) are producer-owned in rp1-home and would
  //    drift out of a server-side literal set, so the security fence for this path
  //    is the scope guard above, NOT the action name.
  if (!isBypass && checkAllowlist(challenge.action, opts.config) === "deny") {
    return { ok: "denied", reason: "provenance-rejected" };
  }

  // 6. State-binding via #3332. An issue-scope match drives the crisp
  //    Layer-1/Layer-2 fingerprint check (byte-identical to pre-#3538, R2). A
  //    BYPASS match (D4/A′) is handed a fingerprint-LESS record so `isValid`
  //    routes it to the hygiene-TTL clock — making `hygiene-expired → state-drift`
  //    reachable AND removing all git/network I/O from the bypass path.
  // #3619 (D1-A): a prod-merge match takes the ORIGIN-REF drift check (V4:
  // mint only while origin/<dev_branch> still equals the approved
  // head_sha). It must NOT use the generic engine: a files:[] binding is
  // vacuously valid from any cwd, which would defeat the drift check.
  if (isProdMerge) {
    const pm = await verifyProdMergeBinding(
      repoPath,
      challenge.state_binding,
      opts.prodMergeTip
    );
    if (pm.kind === "drift") {
      return { ok: "denied", reason: "state-drift" };
    }
    if (pm.kind === "indeterminate") {
      // Deny-on-timeout / malformed binding: never a silent block, never a
      // false valid. Surface the reason so the caller can re-challenge.
      return { ok: "denied", reason: `state-indeterminate: ${pm.reason}` };
    }
    // pm.kind === "valid" -> fall through to mint (step 7).
  } else {
    const gate: GateRecord = isBypass
      ? { minted_at: challenge.minted_at }
      : {
          fingerprint: challenge.state_binding,
          minted_at: challenge.minted_at,
        };
    const check = await isValid(repoPath, gate, opts.stateBinding ?? {});
    switch (check.kind) {
      case "invalid":
        // All invalid reasons (content-changed / approved-path-absent /
        // hygiene-expired) map to #3331's single `state-drift` deny.
        return { ok: "denied", reason: "state-drift" };
      case "indeterminate":
        // Conservative: never silently valid, never silently state-drift. Surface
        // the reason so the caller can re-challenge/escalate.
        return {
          ok: "denied",
          reason: `state-indeterminate: ${check.reason}`,
        };
      case "overlap":
        // Ruling D1a — the decision-menu flow, NOT a denial. Mint NO grant; the
        // caller propagates the analysis so a human/agent decides. (Unreachable for
        // a fingerprint-less bypass gate, but the arm must compile.)
        return { ok: "overlap", key, analysis: check.analysis };
      case "valid":
        break;
    }
  }

  // 7. Valid → mint the single-use grant (consumes the challenge).
  if (key.kind === "issue") {
    const grant = await mintGrant(
      repoPath,
      key.issueNumber,
      challenge,
      opts.origin
    );
    return { ok: "granted", key, grant };
  }
  // Bypass → mint to the machine-global store. `null` means a concurrent minter
  // claimed the challenge first → replay. (`opts.globalStateDir!`: see step 2.)
  const grant = await mintGlobalGrant(
    opts.globalStateDir!,
    key.scopeKey,
    challenge,
    opts.origin
  );
  if (!grant) return { ok: "denied", reason: "replayed" };
  return { ok: "granted", key, grant };
}

/** True iff a challenge OR grant file for `issueNumber` exists (used by the
 *  reap-veto's sibling check to decide "a live approval flow is in flight"). */
export function hasLiveApprovalArtifact(
  repoPath: string,
  issueNumber: number
): boolean {
  return (
    existsSync(challengeFile(repoPath, issueNumber)) ||
    existsSync(grantFile(repoPath, issueNumber))
  );
}

// ── Approval-state read surface (R10 / epic GAP-1) ──────────────────────────

/**
 * The card-display states (registry vocabulary, shared with #3333's approval
 * card and #3332's outcomes). `none` is the read-surface's "no artifact" signal
 * (outside the four display states) so the card can poll and see "no gate".
 */
export type ApprovalState =
  | "pending"
  | "consumed"
  | "used"
  | "invalidated"
  | "awaiting-overlap-decision"
  | "none";

export interface ApprovalStateResult {
  state: ApprovalState;
  nonce?: string;
  action?: string;
  scope?: string;
  /** Present on `consumed` — the grant's audit identity. */
  approved_by?: string;
  origin?: string;
  /** Present on `consumed` — when the grant was minted (registry §4.1), so the
   *  card can render "Approved · waiting for the agent" with a timestamp (#3559 R6). */
  minted_at?: string;
  /** Present on `used` — the acceptance-ledger `ts` (when the gate consumed the
   *  grant); the client formats it to locale (#3559 R6). */
  consumed_at?: string;
  /** Present on `invalidated` / `awaiting-overlap-decision` — the drift/overlap
   *  reason, so the card can render why the gate is not simply pending. */
  reason?: string;
}

/**
 * Compute the live approval state for an issue's gate (R10). A grant on disk ⇒
 * `consumed` (the nonce was consumed to mint it). Otherwise a pending challenge
 * is re-checked against #3332's state-binding at READ time, so the card sees the
 * LIVE state: valid ⇒ `pending`; state-drift ⇒ `invalidated`; overlap ⇒
 * `awaiting-overlap-decision`; indeterminate ⇒ `pending` (conservative — still
 * awaiting). Neither artifact: an exact-nonce acceptance-ledger hit ⇒ `used`
 * (#3559 R6 — the gate ran to completion), else `none`. Read-only; mints/consumes
 * nothing. `used` requires BOTH `opts.nonce` and `opts.globalStateDir`.
 */
export async function computeApprovalState(
  repoPath: string,
  issueNumber: number,
  opts: IsValidOptions & { globalStateDir?: string; nonce?: string } = {}
): Promise<ApprovalStateResult> {
  const grant = readGrant(repoPath, issueNumber);
  if (grant) {
    return {
      state: "consumed",
      nonce: grant.nonce,
      action: grant.action,
      scope: grant.scope,
      approved_by: grant.approved_by,
      origin: grant.origin,
      minted_at: grant.minted_at,
    };
  }
  const challenge = readChallenge(repoPath, issueNumber);
  if (!challenge) {
    // No grant, no live challenge. The gate may have RUN to completion — the
    // grant was minted (consuming the challenge) then gate-consumed (deleting the
    // grant + appending the acceptance ledger). An exact-nonce ledger hit reports
    // `used` (#3559 R6) so the card shows "Used" instead of snapping to Pending.
    // Requires BOTH the card's nonce AND the injected state base; with NO nonce we
    // do NOT issue-scope scan — a stale row from a PRIOR cycle would falsely report
    // `used` for a freshly minted challenge.
    if (opts.nonce && opts.globalStateDir) {
      const hit = scanAcceptanceLedger(opts.globalStateDir, opts.nonce);
      if (hit) {
        return {
          state: "used",
          nonce: opts.nonce,
          ...(hit.at != null ? { consumed_at: hit.at } : {}),
        };
      }
    }
    return { state: "none" };
  }
  const base = {
    nonce: challenge.nonce,
    action: challenge.action,
    scope: challenge.scope,
  };
  const check = await isValid(
    repoPath,
    { fingerprint: challenge.state_binding, minted_at: challenge.minted_at },
    opts
  );
  switch (check.kind) {
    case "valid":
      return { state: "pending", ...base };
    case "invalid":
      return { state: "invalidated", ...base, reason: check.reason };
    case "overlap":
      return {
        state: "awaiting-overlap-decision",
        ...base,
        reason: check.analysis.recommendation,
      };
    case "indeterminate":
      return { state: "pending", ...base, reason: check.reason };
  }
}
