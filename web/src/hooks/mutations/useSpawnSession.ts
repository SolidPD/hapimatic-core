// SPDX-License-Identifier: AGPL-3.0-only
import type { ExistingBranch } from "@hapi/protocol/gitBranches";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SpawnResponse } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type { ModelMode } from "@hapi/protocol/modes";
import type { EffortLevel } from "@hapi/protocol";

// Exported so the shared spawn-command assembler (NewSession/spawnCommand.ts,
// #1949 A2) and the formState memo (#1950 A3) build from ONE payload definition.
export type SpawnInput = {
  /** Local machine spawn (mutually exclusive with nodeId). */
  machineId?: string;
  /** Remote node spawn via federation (mutually exclusive with machineId). */
  nodeId?: string;
  directory: string;
  agent?: "claude" | "codex" | "gemini" | "opencode";
  yolo?: boolean;
  /** Issue #1262: opt-in to spawn-time port claim. User-driven spawns
   *  from the create dialog default to `true` so a fresh worktree gets
   *  a port slot reserved (preserving pre-#1262 UX). */
  claimPort?: boolean;
  sessionType?: "simple" | "worktree";
  worktreeName?: string;
  /** hapimatic-private#4481: open the worktree on this EXISTING branch. */
  existingBranch?: ExistingBranch;
  /** Session display name (applied after spawn). */
  name?: string;
  /** Session emoji (applied after spawn). */
  emoji?: string;
  /** Correlation ID for reliable stub-to-session matching (issue #933). */
  spawnCorrelationId?: string;
  /** Multi-account (#1455): bind the new session to this stored account. */
  accountUuid?: string;
  /** Issue #4568: bill the new Claude session to this node-vault Anthropic API
   *  key id (never the key). LOCAL spawns only — mutually exclusive with
   *  `accountUuid`; the remote branch below never forwards it. */
  apiKeyId?: string;
  /** Issue #1633: launch with Claude Code's --safe-mode (scaffolding
   *  disabled) — for Fable content-sensitivity testing. Spawn-only. */
  safeMode?: boolean;
  /** Issue #1660: per-session launcher override (sdk | tmux | pty). Omitted
   *  (left undefined) by the create page when it equals the global default. */
  launcher?: ClaudeRemoteLauncherKind;
  /** Issue #1733: OpenRouter model id ("provider/model") for a Codex session
   *  on a gateway:openrouter-capable target. Set by the model picker. */
  model?: string;
  /** Issue #3349 (ruling D4(a)): native-vs-OpenRouter routing discriminator for
   *  an opencode spawn. `"native"` → `model` above is a native `provider/model`
   *  whose key is resolved from the #1955 vault; omitted for OpenRouter (the
   *  daemon defaults to model-presence-means-OpenRouter, R6). Set by the opencode
   *  native picker (NativeProviderModelFields, #3349). */
  modelRouting?: "native" | "openrouter";
  /** Issue #1953 (A6): clone-on-spawn repo ("owner/repo"). When set, the daemon
   *  clones it into `directory` before launch. Threaded through every spawn hop
   *  (#1262); standard session mode only. */
  cloneRepo?: string;
  /** Issue #2434: Claude model-mode pin ("sonnet"|"opus"|"fable") set by the
   *  Create page's model dropdown, so the session starts on the intended model
   *  atomically. DISTINCT from `model` above — that is the #1733 OpenRouter
   *  GATEWAY axis (codex/opencode); this is the Claude axis. The two are
   *  mutually exclusive in the UI (flavor-conditional) but coexist on the wire.
   *  Omitted for "default" so an unpinned spawn stays byte-identical. */
  modelMode?: ModelMode;
  /** Issue #2456: reasoning-effort level for the create page's Effort dropdown. */
  effort?: EffortLevel;
  /** Issue #2456: a specific pinned raw Claude model id from the full-catalog
   *  Model dropdown ("More models"). Threaded daemon-ward as --hapi-raw-model. */
  rawModel?: string;
  /** Issue #2626 (D): per-session output style name for the create-page Output
   *  Style dropdown. Threaded daemon-ward as --hapi-output-style; buildSpawnInput
   *  already gated it (claude-only + omit when "default"). */
  outputStyle?: string;
  /**
   * Issue #3348: bundled non-claude native model selection. `modelId` is the
   * gemini model id (→ `GEMINI_MODEL` env) OR the codex ChatGPT-token model id
   * (→ config.toml bake) — interpreted by AGENT at the daemon; `reasoningEffort`
   * is codex's config.toml `model_reasoning_effort`. Threaded through every spawn
   * hop as ONE field (#1262). Omitted for claude / OpenRouter / opencode so those
   * spawns stay byte-identical.
   */
  nativeModelSelection?: { modelId?: string; reasoningEffort?: string };
  /** Issue #3515: opt in to the early-ack optimistic-spawn path (LOCAL spawns
   *  only). When true the local spawn returns `{type:"accepted", sessionId}`
   *  before the daemon spawn resolves. Ignored by the federated `spawnOnNode`
   *  branch (remote parity is descoped — ruling D4). */
  earlyReturn?: boolean;
};

export function useSpawnSession(api: ApiClient | null): {
  spawnSession: (input: SpawnInput) => Promise<SpawnResponse>;
  isPending: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: SpawnInput) => {
      if (!api) {
        throw new Error("API unavailable");
      }

      if (input.nodeId) {
        return await api.spawnOnNode(
          input.nodeId,
          input.directory,
          input.agent,
          input.yolo,
          input.sessionType,
          input.worktreeName,
          input.name,
          input.emoji,
          input.spawnCorrelationId,
          input.claimPort,
          input.accountUuid,
          input.safeMode,
          input.launcher,
          input.model,
          // Issue #3349 (D4(a)): native-vs-OpenRouter routing discriminator.
          input.modelRouting,
          input.cloneRepo,
          input.modelMode,
          input.effort,
          input.rawModel,
          input.outputStyle,
          // Issue #3348: bundled gemini/codex native model selection.
          input.nativeModelSelection,
          // hapimatic-private#4481: existing-branch worktree.
          input.existingBranch
        );
      }

      if (!input.machineId) {
        throw new Error("No machine or node selected");
      }

      return await api.spawnSession(
        input.machineId,
        input.directory,
        input.agent,
        input.yolo,
        input.sessionType,
        input.worktreeName,
        input.name,
        input.claimPort,
        input.accountUuid,
        input.safeMode,
        input.launcher,
        input.model,
        // Issue #3349 (D4(a)): native-vs-OpenRouter routing discriminator (the
        // LOCAL branch must forward it too, mirroring spawnOnNode above).
        input.modelRouting,
        input.cloneRepo,
        input.modelMode,
        // Issue #2456: the local-machine spawn branch must forward the
        // reasoning-effort + pinned raw model too (the federated `spawnOnNode`
        // branch above already does). Omitting them here silently dropped the
        // create-page Effort / Model selections on every LOCAL spawn.
        input.effort,
        input.rawModel,
        input.outputStyle,
        // Issue #3348: bundled gemini/codex native model selection.
        input.nativeModelSelection,
        // Issue #3515: opt the LOCAL spawn into the early-ack optimistic path.
        input.earlyReturn,
        // hapimatic-private#4481: existing-branch worktree.
        input.existingBranch,
        // Issue #4568: the API-key binding (local only — see SpawnInput).
        input.apiKeyId
      );
    },
    onSuccess: (data, input) => {
      // Issue #2270 (F22): a spawn error travels IN-BAND (HTTP 200 body,
      // {type:"error"}), so the mutation RESOLVES and `onSuccess` fires even on
      // failure. Only a genuine success should invalidate the session list —
      // invalidating on an in-band failure triggers a spurious sessions refetch
      // (a contributor to the F22 "flash") and is semantically wrong (no session
      // was created). The create page reads `result.message` and surfaces it.
      //
      // Issue #3515: the early-ack `accepted` variant IS a real spawn in flight
      // (a `spawning` placeholder exists server-side), so it invalidates the
      // session list too — the placeholder should render immediately rather than
      // wait for the `session-added` SSE. It is LOCAL-only (ruling D4), so it
      // never invalidates the federation list.
      if (data.type !== "success" && data.type !== "accepted") return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      if (data.type === "success" && input.nodeId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.federationAllSessions,
        });
      }
    },
  });

  return {
    spawnSession: mutation.mutateAsync,
    isPending: mutation.isPending,
    error:
      mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? "Failed to spawn session"
          : null,
  };
}
