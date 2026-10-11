// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Live Claude model catalog (issue #2456).
 *
 * Fetches Anthropic's Models API (`GET /v1/models`) so the "More models" flyout
 * and the create-page model dropdown always reflect the CURRENT set of models —
 * a new model Anthropic ships appears with no code change. Verified 2026-07-30:
 * the endpoint returns HTTP 200 with a Hapimatic subscription OAuth token (no
 * API key needed) and carries `id`, `display_name`, `max_input_tokens`, and a
 * `capabilities.effort` per-level support tree.
 *
 * Resilience (Fallback Preservation Rule): a fresh cache is served first; on a
 * live-fetch failure it degrades to the last-good cache, then to the static
 * {@link FALLBACK_CLAUDE_MODELS} — the picker is never empty. A short failure
 * cooldown keeps a downed API from being hit on every page load.
 *
 * Security: the resolved OAuth token is NEVER logged. Failures log the HTTP
 * status / error message only, never the token (mirrors accountTokenInjection).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  EFFORT_LEVELS,
  FALLBACK_CLAUDE_MODELS,
  type ClaudeModelInfo,
  type ClaudeModelsResponse,
  type EffortLevel,
} from "@hapi/protocol";
import type { AccountService } from "./accountService";
import type { ErrorLogger } from "../logging/errorLogger";

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const CACHE_TTL_MS = 10 * 60 * 1000; // serve a live catalog for 10 minutes
const FAIL_COOLDOWN_MS = 60 * 1000; // after a failure, wait 60s before retrying live
const FETCH_TIMEOUT_MS = 8000;

interface CacheEntry {
  at: number;
  models: ClaudeModelInfo[];
}

export class ClaudeModelCatalogService {
  private cache: CacheEntry | null = null;
  private cooldownUntil = 0;
  private inflight: Promise<ClaudeModelInfo[]> | null = null;

  constructor(
    private readonly accountService: AccountService,
    private readonly errorLogger?: ErrorLogger | null,
    // Injectable for tests; defaults to the global fetch.
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /**
   * Resolve the model catalog. Never throws — always returns a usable list,
   * tagged with where it came from (`live` | `cache` | `fallback`).
   */
  async getModels(): Promise<ClaudeModelsResponse> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) {
      return { models: this.cache.models, source: "cache" };
    }
    // Recently failed: don't hammer Anthropic — serve stale cache or fallback.
    if (now < this.cooldownUntil) {
      return this.cache
        ? { models: this.cache.models, source: "cache" }
        : { models: FALLBACK_CLAUDE_MODELS, source: "fallback" };
    }
    try {
      const models = await this.fetchLive();
      this.cache = { at: Date.now(), models };
      return { models, source: "live" };
    } catch (err) {
      this.cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
      this.errorLogger?.warn(
        `Claude model catalog live fetch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { category: "claude-models" }
      );
      if (this.cache) {
        return { models: this.cache.models, source: "cache" };
      }
      return { models: FALLBACK_CLAUDE_MODELS, source: "fallback" };
    }
  }

  /** Dedupe concurrent live fetches (many tabs opening the create page at once). */
  private fetchLive(): Promise<ClaudeModelInfo[]> {
    if (this.inflight) return this.inflight;
    this.inflight = this.doFetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doFetch(): Promise<ClaudeModelInfo[]> {
    const tokens = this.resolveTokens();
    if (tokens.length === 0) {
      throw new Error("no OAuth token available to call /v1/models");
    }
    // Try each candidate token until one authenticates. Any single stored token
    // can be stale (a worktree instance without a running TokenRefreshService, an
    // expired snapshot); the host token is the fresh safety net. The catalog is
    // account-independent, so any 200 is correct. Bounded by the token count.
    let lastStatus = 0;
    for (const token of tokens) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await this.fetchImpl(ANTHROPIC_MODELS_URL, {
          headers: {
            Authorization: `Bearer ${token}`,
            "anthropic-version": "2023-06-01",
            // OAuth (subscription) tokens require this beta header on most
            // endpoints; harmless on the rest. See the claude-api skill.
            "anthropic-beta": "oauth-2025-04-20",
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        return normalizeModels(await res.json());
      }
      lastStatus = res.status;
      // Non-2xx (typically 401 from a stale token) → try the next candidate.
    }
    throw new Error(
      `/v1/models: all ${tokens.length} token(s) failed (last HTTP ${lastStatus})`
    );
  }

  /**
   * All candidate subscription OAuth tokens, in preference order (deduped): the
   * node's active account, then every stored account (kept fresh by the daemon's
   * TokenRefreshService), then the host credentials (kept fresh by Claude Code
   * itself). doFetch tries each until one authenticates, so a single stale token
   * never forces a fallback. Never logs a token value.
   */
  private resolveTokens(): string[] {
    const tokens: string[] = [];
    const add = (token: string | null | undefined): void => {
      if (token && !tokens.includes(token)) tokens.push(token);
    };
    const activeUuid = this.accountService.getActiveAccount()?.accountUuid;
    if (activeUuid) add(this.accountService.getRaw(activeUuid)?.accessToken);
    for (const account of this.accountService.list()) {
      // #3808 (R7): only Anthropic accounts carry an accessToken usable against
      // api.anthropic.com/v1/models. getRaw() is Anthropic-only (a provider record
      // returns null), so this skip is defence in depth + avoids a wasted read.
      // (absent provider ⇒ anthropic)
      if ((account.provider ?? "anthropic") !== "anthropic") continue;
      add(this.accountService.getRaw(account.accountUuid)?.accessToken);
    }
    add(readHostToken());
    return tokens;
  }
}

/** Normalize Anthropic's `/v1/models` payload into the shared shape. */
export function normalizeModels(body: unknown): ClaudeModelInfo[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("unexpected /v1/models response shape (no data array)");
  }
  const out: ClaudeModelInfo[] = [];
  for (const entry of data) {
    const model = entry as {
      id?: unknown;
      display_name?: unknown;
      max_input_tokens?: unknown;
      capabilities?: {
        effort?: { supported?: boolean } & Record<
          string,
          { supported?: boolean } | boolean | undefined
        >;
      };
    };
    if (typeof model.id !== "string") continue;
    const displayName =
      typeof model.display_name === "string" ? model.display_name : model.id;
    const effortCap = model.capabilities?.effort;
    const effortLevels: EffortLevel[] = [];
    if (effortCap?.supported) {
      for (const level of EFFORT_LEVELS) {
        const levelCap = effortCap[level];
        if (
          typeof levelCap === "object" &&
          levelCap !== null &&
          levelCap.supported
        ) {
          effortLevels.push(level);
        }
      }
    }
    out.push({
      id: model.id,
      displayName,
      effortLevels,
      ...(typeof model.max_input_tokens === "number"
        ? { maxInputTokens: model.max_input_tokens }
        : {}),
    });
  }
  if (out.length === 0) {
    throw new Error("no Claude models parsed from /v1/models");
  }
  return out;
}

/** Host-default OAuth token from `~/.claude/.credentials.json`, or null. */
function readHostToken(): string | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8")
    ) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = raw.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
