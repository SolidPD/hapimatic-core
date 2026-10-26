// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GoogleAuthState, OpenAiAuthState } from "@hapi/protocol";
import { openAiPk } from "./providerAccountImport";

/**
 * Provider auth-state reader (issue #3806, epic #3345 — the ROOT of the
 * non-Anthropic-parity chain #3806 → #3807 → #3808 → #3809).
 *
 * Derives, for the LOCAL node, the DERIVED-fields-only OpenAI (Codex) + Gemini
 * (Google) auth state. It returns the bare facts (`{ openai, google }`); the
 * routes (`web/routes/accounts.ts` local + `web/routes/federation/accounts.ts`
 * hub/receiver) own node-id stamping, envelope wrapping, and the
 * `.parse()`-on-egress that makes the no-token guarantee structural.
 *
 * 🔴 SECRETS: this module reads `<home>/auth.json`, `~/.gemini/settings.json`, and
 * the account-configs sidecars, but the raw tokens / keys NEVER leave the
 * function — only `mode` / `email` / `plan` / `expiresAt` / `accountId` (id-token
 * CLAIMS + a non-secret account id) and the Gemini `selectedAuthType` / `bound` /
 * `keySource` cross out. It NEVER logs a token or key value. [ER 2026-09-19: D11]
 * [ER 2026-09-19: 3806-7] [ER 2026-09-19: K-CODEX-HOME]
 */

/** The derived facts for the local node (no node framing — the route adds that). */
export interface ProviderAuthFacts {
  openai: OpenAiAuthState[];
  google: GoogleAuthState;
}

export interface ProviderAuthStateDeps {
  /** Home dir. Default: os.homedir(). Tests inject a temp dir. */
  homeDir?: string;
  /** Host codex home. Default: $CODEX_HOME || <homeDir>/.codex (codex's own resolution order). */
  hostCodexHome?: string;
  /**
   * The machine-global shared account-configs dir (parent of `<pk>/codex/`).
   * Default: `${XDG_CONFIG_HOME:-<homeDir>/.config}/hapimatic/account-configs`
   * (`configuration.accountConfigsDir` in the CLI). K-CODEX-HOME.
   */
  accountConfigsDir?: string;
  /** Path to the gemini-cli settings. Default: <homeDir>/.gemini/settings.json. */
  geminiSettingsPath?: string;
  /**
   * Providers (lowercased) present in this node's vault — the reader treats
   * `gemini`/`google` as the Gemini-key-present signal. Default: empty set
   * (buildWebApp injects the real `readSettings().apiKeys`-derived set).
   */
  getVaultProviders?: () => Promise<Set<string>> | Set<string>;
  /**
   * This node's daemon `providerEnv` presence names (Task 0), or null when
   * unknown (no local machine record / stale daemon). Default: null (buildWebApp
   * injects the real `getMachines(db)`-derived list). [ER 2026-09-19: D11]
   */
  getDaemonProviderEnv?: () => string[] | null;
}

/**
 * The codex 0.147.0 `auth.json` shape we DERIVE from — a NARROW read; only these
 * fields are touched, and the token strings never escape this module.
 * (`codex-rs/login/src/auth/storage.rs` at `rust-v0.147.0`.)
 */
interface CodexAuthDotJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  } | null;
  last_refresh?: string;
}

/**
 * Base64url-decode a JWT's payload segment and return its claims — NEVER throws,
 * NEVER logs the token. Returns null on any malformed input (the derived-fields
 * discipline: a bad token yields no claims, not an error).
 */
function decodeJwtClaims(
  jwt: string | undefined
): Record<string, unknown> | null {
  if (!jwt || typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    const claims = JSON.parse(json);
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

/** Extract the ChatGPT plan-type claim from the id-token's OpenAI auth namespace. */
function extractPlan(
  claims: Record<string, unknown> | null
): string | undefined {
  if (!claims) return undefined;
  const ns = claims["https://api.openai.com/auth"];
  if (ns && typeof ns === "object") {
    const plan = (ns as Record<string, unknown>).chatgpt_plan_type;
    if (typeof plan === "string" && plan.length > 0) return plan;
  }
  const flat = claims.chatgpt_plan_type ?? claims.plan;
  return typeof flat === "string" && flat.length > 0 ? flat : undefined;
}

/** Derive one OpenAI row from a codex home dir. The dir is assumed to exist. */
async function deriveOpenAiRow(
  home: string,
  source: "host" | "account",
  accountUuid: string | null,
  label: string | undefined
): Promise<OpenAiAuthState> {
  const authPath = join(home, "auth.json");
  // A MISSING auth.json → "unknown" (codex 0.147.0 supports keyring credential
  // storage, so the dir can be logged-in with no auth.json). The copy says
  // "unknown — run codex login status", never "not logged in". [ER 2026-09-19: 3806-7]
  if (!existsSync(authPath)) {
    return {
      accountUuid,
      source,
      mode: "unknown",
      ...(label ? { label } : {}),
    };
  }
  let auth: CodexAuthDotJson;
  try {
    auth = JSON.parse(await readFile(authPath, "utf8")) as CodexAuthDotJson;
  } catch {
    // Present but unreadable/corrupt → "unknown" (never surface the parse error
    // with any token material).
    return {
      accountUuid,
      source,
      mode: "unknown",
      ...(label ? { label } : {}),
    };
  }
  const authMode = auth.auth_mode;
  const mode: OpenAiAuthState["mode"] =
    authMode === "chatgpt"
      ? "chatgpt"
      : authMode === "apikey"
        ? "api-key"
        : "unknown";
  // API-key mode has `tokens: None` (no id-token to decode). ChatGPT mode carries
  // the id-token whose CLAIMS give email/plan/expiry — never the token itself.
  const claims = decodeJwtClaims(auth.tokens?.id_token ?? undefined);
  const email =
    typeof claims?.email === "string" ? (claims.email as string) : undefined;
  const plan = extractPlan(claims);
  const exp =
    typeof claims?.exp === "number" ? (claims.exp as number) : undefined;
  const expiresAt =
    exp !== undefined ? new Date(exp * 1000).toISOString() : undefined;
  const accountId =
    typeof auth.tokens?.account_id === "string" &&
    auth.tokens.account_id.length > 0
      ? auth.tokens.account_id
      : undefined;
  // #3982: the host login has no account dir to name it, so key it by the store
  // PK the importer mints for it (providerAccountImport.ts, `openAiPk`); the
  // Accounts page joins it to its record that way and marks it read-only (D2).
  const resolvedUuid =
    accountUuid ??
    (source === "host" && accountId ? openAiPk(accountId) : null);
  return {
    accountUuid: resolvedUuid,
    source,
    mode,
    ...(label ? { label } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

/** Enumerate the codex logins on this node: host `~/.codex` + each per-account dir. */
async function readOpenAiState(
  deps: ProviderAuthStateDeps,
  homeDir: string
): Promise<OpenAiAuthState[]> {
  const rows: OpenAiAuthState[] = [];

  // Host `~/.codex` (source:"host", the pre-#3808 single login). Its accountUuid is
  // the importer's store PK `openAiPk(accountId)` when auth.json names an account
  // id (#3982), else null (keyring storage / API-key login).
  // Emitted only when the dir exists — a node that has never used codex shows no
  // host row, so the OpenAI section renders its empty state (host-side instructions).
  const hostHome =
    deps.hostCodexHome ?? process.env.CODEX_HOME ?? join(homeDir, ".codex");
  if (existsSync(hostHome)) {
    rows.push(await deriveOpenAiRow(hostHome, "host", null, undefined));
  }

  // Per-account `<accountConfigsDir>/<pk>/codex/` dirs (source:"account", K-CODEX-HOME).
  const accountConfigsDir =
    deps.accountConfigsDir ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homeDir, ".config"),
      "hapimatic",
      "account-configs"
    );
  if (existsSync(accountConfigsDir)) {
    let entries: string[] = [];
    try {
      const dirents = await readdir(accountConfigsDir, { withFileTypes: true });
      entries = dirents.filter(d => d.isDirectory()).map(d => d.name);
    } catch {
      entries = [];
    }
    for (const pk of entries) {
      const codexHome = join(accountConfigsDir, pk, "codex");
      if (!existsSync(codexHome)) continue;
      // Non-secret label sidecar written by #3807 — read ONLY if present.
      let label: string | undefined;
      const sidecar = join(accountConfigsDir, pk, "provider-account.json");
      if (existsSync(sidecar)) {
        try {
          const parsed = JSON.parse(await readFile(sidecar, "utf8"));
          if (parsed && typeof parsed.label === "string") label = parsed.label;
        } catch {
          label = undefined;
        }
      }
      rows.push(await deriveOpenAiRow(codexHome, "account", pk, label));
    }
  }

  return rows;
}

/** Map gemini-cli's stored auth-type string to the display literal. */
function mapGeminiAuthType(raw: unknown): GoogleAuthState["selectedAuthType"] {
  switch (raw) {
    case "gemini-api-key":
      return "api-key";
    case "oauth-personal":
      return "google-login";
    case "vertex-ai":
      return "vertex";
    default:
      // Absent / unrecognized. A settings file with no auth block → "none";
      // an unrecognized value → "unknown".
      return raw === undefined || raw === null ? "none" : "unknown";
  }
}

/** Derive the Gemini (Google) auth state for this node. */
async function readGoogleState(
  deps: ProviderAuthStateDeps,
  homeDir: string
): Promise<GoogleAuthState> {
  // selectedAuthType from ~/.gemini/settings.json (gemini-cli 0.57.0 is
  // post-v2-migration: `security.auth.selectedType ?? selectedAuthType`).
  const settingsPath =
    deps.geminiSettingsPath ?? join(homeDir, ".gemini", "settings.json");
  let rawAuthType: unknown = undefined;
  if (existsSync(settingsPath)) {
    try {
      const s = JSON.parse(await readFile(settingsPath, "utf8"));
      rawAuthType =
        s?.security?.auth?.selectedType ?? s?.selectedAuthType ?? undefined;
    } catch {
      rawAuthType = undefined;
    }
  }
  const selectedAuthType = mapGeminiAuthType(rawAuthType);

  // keySource: vault (a `gemini`/`google` apiKeys entry, preferred) → daemon-env
  // (the local machine record's providerEnv carries GEMINI_API_KEY, Task 0) → none.
  // NEVER process.env in the server, NEVER a filesystem probe of unit files.
  let keySource: GoogleAuthState["keySource"] = "none";
  const vaultProviders =
    (await deps.getVaultProviders?.()) ?? new Set<string>();
  if (vaultProviders.has("gemini") || vaultProviders.has("google")) {
    keySource = "vault";
  } else {
    const daemonEnv = deps.getDaemonProviderEnv?.() ?? null;
    if (daemonEnv?.includes("GEMINI_API_KEY")) {
      keySource = "daemon-env";
    }
  }
  return { selectedAuthType, bound: keySource !== "none", keySource };
}

/**
 * Read the LOCAL node's provider auth facts. Returns derived fields ONLY — the
 * raw tokens/keys never leave this function.
 */
export async function readProviderAuthState(
  deps: ProviderAuthStateDeps = {}
): Promise<ProviderAuthFacts> {
  const homeDir = deps.homeDir ?? homedir();
  const [openai, google] = await Promise.all([
    readOpenAiState(deps, homeDir),
    readGoogleState(deps, homeDir),
  ]);
  return { openai, google };
}
