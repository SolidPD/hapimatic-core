// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #1975 — OpenCode (sst/opencode) ACP harness config emission.
 *
 * Builds the inline JSON passed to the spawned `opencode acp` process via the
 * `OPENCODE_CONFIG_CONTENT` env var (paired with `OPENCODE_DISABLE_PROJECT_CONFIG=1`
 * so the node's own `opencode.json` can't override it). This is the OpenCode
 * analogue of `cli/src/codex/utils/codexProviderConfig.ts`, but simpler on the
 * secret-handling axis: OpenCode auto-detects `OPENROUTER_API_KEY` straight from
 * the process env (ADR §3.1, verified end-to-end), so the OpenRouter key NEVER
 * appears in this config — not even as a `{env:...}` placeholder. The config
 * carries only the selected model and the permission posture.
 *
 * Model id: the web picker emits a bare `provider/model` (e.g. `openai/gpt-4o`);
 * OpenCode addresses an OpenRouter-routed model as `openrouter/<provider>/<model>`.
 * That `openrouter/` transform lives HERE, in one place (KD-4), so the daemon
 * never re-derives it.
 */

/**
 * Env var OpenCode reads the OpenRouter key from. The daemon sets it in the
 * spawned process env (see `cli/src/daemon/run.ts`); OpenCode auto-detects it
 * with zero config. Named to mirror `codexProviderConfig.OPENROUTER_ENV_KEY`
 * (same key, different delivery — codex references it from `config.toml`,
 * OpenCode reads it from the environment directly).
 */
export const OPENROUTER_ENV_KEY = "OPENROUTER_API_KEY";

/** OpenCode config schema URL — pins the schema OpenCode validates against. */
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * OpenCode's OpenRouter provider-id prefix. The picker emits a bare
 * `provider/model`; OpenCode addresses an OpenRouter model as
 * `openrouter/<provider>/<model>`.
 */
const OPENROUTER_MODEL_PREFIX = "openrouter/";

/** Permission verb OpenCode understands per tool category. */
type OpenCodePermission = "allow" | "ask";

/**
 * Prepend the `openrouter/` provider prefix to a bare picker model id. Idempotent
 * — an already-prefixed id is returned unchanged (defensive against a caller that
 * pre-normalized).
 */
export function toOpenRouterModelId(model: string): string {
  return model.startsWith(OPENROUTER_MODEL_PREFIX)
    ? model
    : `${OPENROUTER_MODEL_PREFIX}${model}`;
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` JSON string for an OpenCode ACP session.
 *
 * Issue #3349 dropped the OpenRouter-mandatory constraint: OpenCode now spawns
 * against EITHER the OpenRouter gateway OR a NATIVE provider keyed from the #1955
 * apiKeys vault. The two are a DISCRIMINATED UNION on `routing` — the explicit
 * ruling-D4(a) wire discriminator, NOT a string-shape heuristic on the model id:
 *
 * - `routing: "openrouter"` — the pre-#3349 path, kept BYTE-IDENTICAL (R5): the
 *   picker's bare `provider/model` gets the `openrouter/` prefix; the OpenRouter
 *   key is NEVER in this config (OpenCode reads `OPENROUTER_API_KEY` from the env).
 * - `routing: "native"` — a native `<provider>/<model>` reference plus a
 *   `provider.<id>.options.apiKey` block. The provider key is delivered IN the
 *   config here (a first-class `opencode.ai/config.json` field, verified against
 *   opencode 1.17.11). The config content rides `OPENCODE_CONFIG_CONTENT` — the
 *   SAME process-env trust boundary as the OpenRouter path's `OPENROUTER_API_KEY`
 *   (never on the spawn wire, never in session metadata, never in the DOM/preview).
 *
 * @param args.yolo `true` → every tool category is `allow` (no permission
 *                  prompts); `false` → every category is `ask`, so OpenCode
 *                  raises an ACP `session/request_permission` before acting.
 * @returns A JSON string.
 */
export function buildOpenCodeConfigContent(
  args:
    | { routing: "openrouter"; model: string; yolo: boolean }
    | {
        routing: "native";
        provider: string;
        model: string;
        apiKey: string;
        yolo: boolean;
      }
): string {
  const permission: OpenCodePermission = args.yolo ? "allow" : "ask";
  const permissionBlock = {
    edit: permission,
    bash: permission,
    webfetch: permission,
  };
  if (args.routing === "native") {
    // Native provider block: OpenCode addresses the model as `<provider>/<model>`
    // and reads the per-provider key from `provider.<id>.options.apiKey`
    // (opencode.ai/config.json ProviderConfig, verified 1.17.11). The bare model
    // id is used AS-IS (NO `openrouter/` prefix — that transform is OpenRouter-only).
    const config = {
      $schema: OPENCODE_CONFIG_SCHEMA,
      provider: {
        [args.provider]: {
          options: { apiKey: args.apiKey },
        },
      },
      model: `${args.provider}/${args.model}`,
      permission: permissionBlock,
    };
    return JSON.stringify(config);
  }
  // OpenRouter (routing: "openrouter") — byte-identical to pre-#3349 (R5): key
  // order {$schema, model, permission}, `openrouter/` prefix, no key in config.
  const config = {
    $schema: OPENCODE_CONFIG_SCHEMA,
    model: toOpenRouterModelId(args.model),
    permission: permissionBlock,
  };
  return JSON.stringify(config);
}
