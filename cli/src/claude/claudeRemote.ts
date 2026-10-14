// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { EnhancedMode } from "./loop";
import {
  query,
  type QueryOptions as Options,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKResultMessage,
  type Query,
  AbortError,
  SDKUserMessage,
} from "@/claude/sdk";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from "node:path";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import {
  buildSystemPrompt,
  resolveSdkSystemPrompts,
} from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { getDefaultClaudeCodePath } from "./sdk/utils";
import { buildImageContent } from "./utils/parseImageAttachments";
import {
  cleanupHookSettingsFile,
  generateApiKeyHelperSettingsFile,
} from "./utils/generateHookSettings";
import { readBoundApiKeyBinding } from "./accountTokenInjection";

export async function claudeRemote(opts: {
  // Fixed parameters
  sessionId: string | null;
  path: string;
  mcpServers?: Record<string, any>;
  claudeEnvVars?: Record<string, string>;
  /** Issue #4568 (F1): the session bills an API key through its `apiKeyHelper`. */
  apiKeyHelperSession?: boolean;
  claudeArgs?: string[];
  allowedTools: string[];
  hookSettingsPath: string;
  signal?: AbortSignal;
  canCallTool: (
    toolName: string,
    input: unknown,
    mode: EnhancedMode,
    options: { signal: AbortSignal }
  ) => Promise<PermissionResult>;

  // Dynamic parameters
  nextMessage: () => Promise<{ message: string; mode: EnhancedMode } | null>;
  onReady: () => void;
  isAborted: (toolCallId: string) => boolean;

  // Callbacks
  onSessionFound: (id: string) => void;
  onThinkingChange?: (thinking: boolean) => void;
  // Issue #1469: first-order per-turn context usage (model name + window),
  // sourced from get_context_usage. Replaces the stale system.init onModelResolved.
  onContextUsage?: (usage: {
    resolvedModel: string;
    contextWindowTokens: number;
    contextUsedTokens: number;
    contextPercentage: number;
  }) => void;
  onMessage: (message: SDKMessage) => void;
  onCompletionEvent?: (message: string) => void;
  onSessionReset?: () => void;
  /**
   * Fires after the SDK Query instance is created. The remote launcher uses
   * this to capture the instance for out-of-band control requests (e.g. the
   * mcp-toggle RPC in issue #1077).
   */
  onQueryCreated?: (query: Query) => void;

  /**
   * Issue #1442: invoked with the list of attached-file paths present in the
   * message footer that failed to stat()/read at parse time (uploads the server
   * confirmed but whose bytes never reached disk). The remote launcher wires
   * this to the #1078 tool-error toast so the sender is no longer silently
   * fooled into thinking all attachments were delivered.
   */
  onMissingAttachments?: (missingPaths: string[]) => void;
}) {
  const debugPrefix = "[claudeRemote][async-debug]";

  // Check if session is valid
  let startFrom = opts.sessionId;
  if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
    startFrom = null;
  }

  // Extract --resume from claudeArgs if present (for first spawn)
  if (!startFrom && opts.claudeArgs) {
    for (let i = 0; i < opts.claudeArgs.length; i++) {
      if (opts.claudeArgs[i] === "--resume") {
        // Check if next arg exists and looks like a session ID
        if (i + 1 < opts.claudeArgs.length) {
          const nextArg = opts.claudeArgs[i + 1];
          // If next arg doesn't start with dash and contains dashes, it's likely a UUID
          if (!nextArg.startsWith("-") && nextArg.includes("-")) {
            startFrom = nextArg;
            logger.debug(
              `[claudeRemote] Found --resume with session ID: ${startFrom}`
            );
            break;
          } else {
            logger.debug(
              "[claudeRemote] Found --resume without session ID - not supported in remote mode"
            );
            break;
          }
        } else {
          logger.debug(
            "[claudeRemote] Found --resume without session ID - not supported in remote mode"
          );
          break;
        }
      }
    }
  }

  // Set environment variables for Claude Code SDK.
  // #1734 (OmniBox Phase 0a, in-path hardening — research code-review #3): the
  // SDK path writes opts.claudeEnvVars (incl. CLAUDE_CODE_OAUTH_TOKEN /
  // CLAUDE_CONFIG_DIR) into the long-lived wrapper process.env and never cleaned
  // up. Capture each touched key's PRIOR value so the main finally can RESTORE
  // it — preventing a binding var from persisting into a later same-process
  // spawn. (Restoration is stricter than a blind delete: a pre-existing value is
  // put back, an absent key is removed.) The early-return paths above this point
  // — abort / no-initial-message / special commands — are single-account,
  // session-terminating exits, so they are an acceptable residual.
  // Issue #4568: `ANTHROPIC_API_KEY` is never mirrored into the wrapper's own
  // process.env, where every other wrapper child (a web-terminal shell, a hook)
  // would inherit it. An API-key session carries no key in claudeEnvVars at all:
  // Claude Code reads it from the settings-file `apiKeyHelper` (F1).
  const claudeEnvVarsPrior = new Map<string, string | undefined>();
  if (opts.claudeEnvVars) {
    const mirrored = Object.entries(opts.claudeEnvVars).filter(
      ([key]) => key !== "ANTHROPIC_API_KEY"
    );
    for (const [key] of mirrored) {
      claudeEnvVarsPrior.set(key, process.env[key]);
    }
    mirrored.forEach(([key, value]) => {
      process.env[key] = value;
    });
  }
  process.env.DISABLE_AUTOUPDATER = "1";

  // Get initial message
  let initial;
  try {
    initial = await opts.nextMessage();
  } catch (e) {
    if (e instanceof AbortError) {
      logger.debug(`[claudeRemote] Aborted during initial message`);
      return;
    }
    throw e;
  }
  if (!initial) {
    // No initial message - exit
    logger.debug(`${debugPrefix} initial nextMessage returned null; exiting`);
    return;
  }
  logger.debug(`${debugPrefix} initial message acquired`);

  // Handle special commands
  const specialCommand = parseSpecialCommand(initial.message);

  // Handle /clear command
  if (specialCommand.type === "clear") {
    if (opts.onCompletionEvent) {
      opts.onCompletionEvent("Context was reset");
    }
    if (opts.onSessionReset) {
      opts.onSessionReset();
    }
    return;
  }

  // Handle /compact command
  let isCompactCommand = false;
  if (specialCommand.type === "compact") {
    logger.debug(
      "[claudeRemote] /compact command detected - will process as normal but with compaction behavior"
    );
    isCompactCommand = true;
    if (opts.onCompletionEvent) {
      opts.onCompletionEvent("Compaction started");
    }
  }

  // Prepare SDK options
  let mode = initial.mode;

  // Issue #1633: mirror the spawn-time bypass pattern below for --safe-mode.
  // The SDK path builds its own argv (claudeArgs are NOT forwarded), so the
  // flag must be threaded explicitly via the safeMode SDK option. When active,
  // Hapimatic's own injections (hapi MCP, hook settings, hapi allowedTools,
  // system-prompt block) are suppressed — empirically --safe-mode disables
  // CLI-arg MCP servers and settings hooks anyway, while --append-system-prompt
  // SURVIVES and would instruct calls to hapi tools that do not exist.
  const spawnTimeSafeMode = opts.claudeArgs?.includes("--safe-mode") ?? false;
  // Issue #1854: branch spawns carry --fork-session in claudeArgs (the daemon's
  // buildClaudeCommand pushes it when forkSession is requested), but the SDK
  // launcher builds its own typed argv and does NOT forward claudeArgs verbatim
  // — so without this extraction it silently drops --fork-session and the branch
  // shares the parent's claudeSessionId/transcript. Mirror the spawnTimeSafeMode
  // extraction and feed it to the query builder via sdkOptions.forkSession.
  const spawnTimeForkSession =
    opts.claudeArgs?.includes("--fork-session") ?? false;
  const resolvedSystemPrompt = spawnTimeSafeMode
    ? undefined
    : buildSystemPrompt(opts.path);
  // R4b (#3748): resolve the custom/append pair so the base prompt (and its
  // Tier-0 block) is injected EXACTLY ONCE — previously folded into BOTH fields,
  // doubling it whenever a customSystemPrompt was set.
  const { customSystemPrompt, appendSystemPrompt } = resolveSdkSystemPrompts(
    initial.mode,
    resolvedSystemPrompt
  );

  // Spawn-time --dangerously-skip-permissions (via --yolo) takes precedence
  // over the web client's message mode. In remote/daemon mode, the SDK is
  // called programmatically — claudeArgs like --dangerously-skip-permissions
  // are not automatically applied to the SDK options the way they are in
  // claudeLocal.ts (where they're passed as subprocess CLI args).
  const spawnTimeBypass = opts.claudeArgs?.includes(
    "--dangerously-skip-permissions"
  );
  const effectivePermissionMode = spawnTimeBypass
    ? "bypassPermissions"
    : initial.mode.permissionMode;

  // Issue #4568 (F1): an API-key session's ONLY credential is the
  // `apiKeyHelper` in its settings file. Safe mode drops the hook settings file
  // (#1633), so a safe-mode key session gets a helper-only file instead —
  // `--safe-mode` still honours it (measured on 2.1.280) while hooks stay off.
  // A key session with no binding fails CLOSED: with no helper the child would
  // fall through to the host login.
  let safeModeHelperSettingsPath: string | undefined;
  if (opts.apiKeyHelperSession) {
    const binding = readBoundApiKeyBinding();
    if (!binding) {
      throw new Error(
        "API-key session has no vault binding — refusing to start without its key"
      );
    }
    if (spawnTimeSafeMode) {
      safeModeHelperSettingsPath = generateApiKeyHelperSettingsFile(binding);
    }
  }

  const sdkOptions: Options = {
    cwd: opts.path,
    resume: startFrom ?? undefined,
    mcpServers: spawnTimeSafeMode ? {} : opts.mcpServers,
    permissionMode: effectivePermissionMode,
    model: initial.mode.model,
    fallbackModel: initial.mode.fallbackModel,
    // Issue #2456: reasoning-effort passthrough → buildClaudeSpawnArgs --effort.
    effort: initial.mode.effort,
    customSystemPrompt,
    appendSystemPrompt,
    allowedTools: spawnTimeSafeMode
      ? initial.mode.allowedTools
      : initial.mode.allowedTools
        ? initial.mode.allowedTools.concat(opts.allowedTools)
        : opts.allowedTools,
    disallowedTools: [
      ...(initial.mode.disallowedTools ?? []),
      "AskUserQuestion",
    ],
    canCallTool: (
      toolName: string,
      input: unknown,
      options: { signal: AbortSignal }
    ) => opts.canCallTool(toolName, input, mode, options),
    abort: opts.signal,
    pathToClaudeCodeExecutable: getDefaultClaudeCodePath(),
    settingsPath: spawnTimeSafeMode
      ? safeModeHelperSettingsPath
      : opts.hookSettingsPath,
    safeMode: spawnTimeSafeMode,
    forkSession: spawnTimeForkSession,
    // Issue #3731 (R1/R2): the EXPLICIT binding set. query() rebuilds the child env
    // from it (buildSdkSpawnEnv) instead of trusting the ambient process.env, which
    // by now is ambient ∪ explicit (the write above) and may carry a stray
    // onboarding token that would override an isolated CLAUDE_CONFIG_DIR.
    bindingEnvVars: opts.claudeEnvVars,
    // Issue #4568 (F1): a key session's credential is its settings-file
    // `apiKeyHelper`; query() strips the env credentials that outrank it.
    apiKeyHelperSession: opts.apiKeyHelperSession,
  };

  // Track whether session ID has been found (to avoid duplicate calls)
  let sessionIdFound = false;

  // Issue #1854 regression sentinel (R4): when a fork was requested but the
  // launched session reports the parent's id (startFrom = the --resume target),
  // the fork silently failed — the branch is aliasing the parent's transcript.
  // Log-only (the session is still usable; this is a regression alarm, not a
  // fatal error). Route both onSessionFound call sites through this helper.
  const reportSessionFound = (id: string) => {
    if (spawnTimeForkSession && startFrom && id === startFrom) {
      logger.error(
        `[claudeRemote] FORK SENTINEL: branch reported parent's claudeSessionId ${id} — --fork-session was dropped/ignored (issue #1854)`
      );
    }
    opts.onSessionFound(id);
  };

  // Track thinking state
  let thinking = false;
  const updateThinking = (newThinking: boolean) => {
    if (thinking !== newThinking) {
      thinking = newThinking;
      logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
      if (opts.onThinkingChange) {
        opts.onThinkingChange(thinking);
      }
    }
  };

  // Push initial message (convert image attachments to base64 content blocks)
  let messages = new PushableAsyncIterable<SDKUserMessage>();
  const initialContent = await buildImageContent(
    initial.message,
    opts.path,
    opts.onMissingAttachments
  );
  messages.push({
    type: "user",
    message: {
      role: "user",
      content: initialContent,
    },
  });

  // Start the loop
  const response = query({
    prompt: messages,
    options: sdkOptions,
  });

  // Expose Query to the caller (e.g. the remote launcher) so it can dispatch
  // out-of-band control requests such as mcp-toggle. Invoked once per
  // claudeRemote() call; ownership ends when this function returns.
  opts.onQueryCreated?.(response);

  // Bounce detection: track consecutive empty results to detect degenerate sessions
  // (e.g., heavily-compacted sessions that return instant empty results without hitting the API)
  const MAX_CONSECUTIVE_EMPTY_RESULTS = 3;
  let consecutiveEmptyResults = 0;

  // Non-blocking message scheduling (ported from upstream tiann/hapi#354).
  // Decouples user input fetching from the for-await message processing loop
  // so SDK messages (background task notifications, held-back results) are
  // consumed continuously even while waiting for user input.
  let nextMessageFetchInFlight = false;
  let inputEnded = false;
  let nextMessageFetchSeq = 0;
  let streamMessageSeq = 0;
  let resultSeq = 0;

  // Issue #1469: fire get_context_usage once per turn (on the first assistant
  // message, where the query is provably active) to push the first-order model
  // name + context window. Reset on each result (turn boundary).
  let contextUsageNeedsRefresh = true;

  const scheduleNextMessage = () => {
    if (nextMessageFetchInFlight || inputEnded) {
      logger.debug(
        `${debugPrefix} scheduleNextMessage skipped ` +
          `(inFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded})`
      );
      return;
    }

    const fetchId = ++nextMessageFetchSeq;
    const startedAt = Date.now();
    nextMessageFetchInFlight = true;
    logger.debug(`${debugPrefix} scheduleNextMessage start fetchId=${fetchId}`);
    void (async () => {
      try {
        const next = await opts.nextMessage();
        if (!next) {
          inputEnded = true;
          messages.end();
          logger.debug(
            `${debugPrefix} nextMessage resolved null fetchId=${fetchId} elapsedMs=${Date.now() - startedAt}; input ended`
          );
          return;
        }
        mode = next.mode;
        // Hapimatic-specific: convert image attachments to base64 content blocks
        const nextContent = await buildImageContent(
          next.message,
          opts.path,
          opts.onMissingAttachments
        );
        messages.push({
          type: "user",
          message: { role: "user", content: nextContent },
        });
        logger.debug(
          `${debugPrefix} nextMessage resolved fetchId=${fetchId} elapsedMs=${Date.now() - startedAt} ` +
            `messageLength=${next.message.length} permissionMode=${next.mode.permissionMode}`
        );
      } catch (e) {
        inputEnded = true;
        if (e instanceof AbortError) {
          messages.end();
          logger.debug(`${debugPrefix} nextMessage aborted fetchId=${fetchId}`);
          return;
        }
        messages.setError(e instanceof Error ? e : new Error(String(e)));
        logger.warn(`${debugPrefix} nextMessage error fetchId=${fetchId}`, e);
      } finally {
        nextMessageFetchInFlight = false;
        logger.debug(
          `${debugPrefix} scheduleNextMessage done fetchId=${fetchId}`
        );
      }
    })();
  };

  updateThinking(true);
  try {
    logger.debug(`[claudeRemote] Starting to iterate over response`);

    for await (const message of response) {
      streamMessageSeq += 1;
      logger.debug(
        `${debugPrefix} stream message #${streamMessageSeq} type=${message.type} ` +
          `subtype=${"subtype" in message ? String((message as any).subtype) : "n/a"}`
      );
      logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

      // Handle messages
      opts.onMessage(message);

      // Issue #1469: on the first assistant message of each turn, fetch the
      // first-order context usage (model + window) while the query is active.
      // Fire-and-forget — never block the message stream; a no_active_query
      // race is swallowed (retain last-known, no proxy fallback).
      if (
        message.type === "assistant" &&
        contextUsageNeedsRefresh &&
        opts.onContextUsage
      ) {
        contextUsageNeedsRefresh = false;
        const onContextUsage = opts.onContextUsage;
        void response
          .getContextUsage()
          .then(u => {
            // Strip the tier suffix (e.g. "claude-opus-4-8[1m]" ->
            // "claude-opus-4-8") so formatModelName matches. The "[" only ever
            // appears as the tier suffix in a model id.
            const bareModel = u.model.includes("[")
              ? u.model.slice(0, u.model.indexOf("["))
              : u.model;
            onContextUsage({
              resolvedModel: bareModel,
              contextWindowTokens: u.maxTokens,
              contextUsedTokens: u.totalTokens,
              contextPercentage: u.percentage,
            });
          })
          .catch(() => {
            // Idle / no_active_query / transient — retain last-known value.
          });
      }

      // Handle special system messages
      if (message.type === "system" && message.subtype === "init") {
        // Start thinking when session initializes
        updateThinking(true);

        const systemInit = message as SDKSystemMessage;

        // Log model resolution for debugging
        logger.debug(
          `[claudeRemote] system.init received - model: ${systemInit.model ?? "undefined"}, session_id: ${systemInit.session_id ?? "undefined"}`
        );

        // Issue #1469: model name + context window are sourced first-order
        // per turn from get_context_usage (see the assistant-message handler
        // above), NOT from this one-time system.init snapshot. The stale-
        // snapshot read was removed here to break the proxy chain.

        // Session id is still in memory, wait until session file is written to disk
        // Start a watcher for to detect the session id
        if (systemInit.session_id && !sessionIdFound) {
          logger.debug(
            `[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`
          );
          const projectDir = getProjectPath(opts.path);
          const found = await awaitFileExist(
            join(projectDir, `${systemInit.session_id}.jsonl`)
          );
          logger.debug(
            `[claudeRemote] Session file found: ${systemInit.session_id} ${found}`
          );
          reportSessionFound(systemInit.session_id);
          sessionIdFound = true;
          logger.debug(
            `[claudeRemote] Session ID found from system.init: ${systemInit.session_id}`
          );
        } else if (!systemInit.session_id) {
          logger.debug(
            "[claudeRemote] system.init message missing session_id - will fallback to result message"
          );
        }
      }

      // Handle result messages
      if (message.type === "result") {
        resultSeq += 1;
        updateThinking(false);
        // Issue #1469: turn boundary — allow the next turn to refresh context usage.
        contextUsageNeedsRefresh = true;

        const resultMsg = message as SDKResultMessage;

        // Structured result logging for debugging
        logger.debug(
          `${debugPrefix} result #${resultSeq} received ` +
            `(nextInFlight=${nextMessageFetchInFlight}, inputEnded=${inputEnded}); ` +
            `subtype=${resultMsg.subtype}, ` +
            `api_ms=${resultMsg.duration_api_ms}, cost=$${resultMsg.total_cost_usd}, ` +
            `turns=${resultMsg.num_turns}, error=${resultMsg.is_error}, ` +
            `stop_reason=${resultMsg.stop_reason ?? "null"}, ` +
            `result_length=${resultMsg.result?.length ?? 0}`
        );

        // Issue #2346 (R6): per-turn cache telemetry. Surface the cache_read /
        // cache_creation token counts Hapimatic already receives on the
        // SDKResultMessage so the saving from eliminating the isPlan mode-hash
        // relaunch (Task 6) is MEASURED, not asserted (#1739 gathered these by
        // hand from transcripts; this productionizes the capture). Both usage
        // fields are OPTIONAL and absent on some result subtypes → guard with
        // `?? 0` (an unguarded read logs `undefined` and defeats the measurement).
        // One structured line per result message (turn boundary) — no hot-path cost.
        logger.debug(
          `${debugPrefix} [cache-telemetry] turn=${resultMsg.num_turns} ` +
            `cache_read=${resultMsg.usage?.cache_read_input_tokens ?? 0} ` +
            `cache_creation=${resultMsg.usage?.cache_creation_input_tokens ?? 0} ` +
            `input=${resultMsg.usage?.input_tokens ?? 0} ` +
            `output=${resultMsg.usage?.output_tokens ?? 0} ` +
            `claudeSessionId=${resultMsg.session_id ?? "unknown"}`
        );

        // Bounce detection: degenerate sessions return instant empty results
        // without hitting the Anthropic API (duration_api_ms === 0)
        const isEmptyBounce =
          resultMsg.duration_api_ms === 0 &&
          (!resultMsg.result || resultMsg.result === "");

        if (isEmptyBounce) {
          consecutiveEmptyResults++;
          logger.warn(
            `[claudeRemote] Empty result bounce detected ` +
              `(${consecutiveEmptyResults}/${MAX_CONSECUTIVE_EMPTY_RESULTS}): ` +
              `duration_api_ms=${resultMsg.duration_api_ms}, ` +
              `stop_reason=${resultMsg.stop_reason ?? "null"}, ` +
              `num_turns=${resultMsg.num_turns}`
          );

          if (consecutiveEmptyResults >= MAX_CONSECUTIVE_EMPTY_RESULTS) {
            logger.warn(
              `[claudeRemote] Bounce loop detected — ${consecutiveEmptyResults} consecutive ` +
                `empty results with 0 API ms. Session is unresponsive. Resetting.`
            );

            if (opts.onCompletionEvent) {
              opts.onCompletionEvent(
                `Session is unresponsive — Claude returned ${consecutiveEmptyResults} ` +
                  `consecutive empty results with no API activity. ` +
                  `This typically happens with heavily-compacted sessions. ` +
                  `Starting a new session...`
              );
            }

            if (opts.onSessionReset) {
              opts.onSessionReset();
            }

            // Exit claudeRemote; the launcher's outer loop will restart with a fresh session
            return;
          }
        } else {
          // Successful result — reset bounce counter
          consecutiveEmptyResults = 0;
        }

        // Fallback: Extract session ID from result message if not found from system.init
        // SDKResultMessage always includes session_id (required field)
        if (!sessionIdFound) {
          if (resultMsg.session_id) {
            logger.debug(
              `[claudeRemote] Session ID found from result message (fallback): ${resultMsg.session_id}`
            );
            const projectDir = getProjectPath(opts.path);
            const found = await awaitFileExist(
              join(projectDir, `${resultMsg.session_id}.jsonl`)
            );
            logger.debug(
              `[claudeRemote] Session file found (fallback): ${resultMsg.session_id} ${found}`
            );
            reportSessionFound(resultMsg.session_id);
            sessionIdFound = true;
          } else {
            logger.warn(
              "[claudeRemote] No session_id found in result message - this is unexpected"
            );
          }
        }

        // Send completion messages
        if (isCompactCommand) {
          logger.debug("[claudeRemote] Compaction completed");
          if (opts.onCompletionEvent) {
            opts.onCompletionEvent("Compaction completed");
          }
          isCompactCommand = false;
        }

        // Send ready event
        opts.onReady();
        logger.debug(`${debugPrefix} onReady emitted for result #${resultSeq}`);

        // Pull next user message without blocking response stream processing.
        // Claude may emit autonomous async messages (e.g. background task notifications)
        // after a result, and we must keep consuming those messages immediately.
        scheduleNextMessage();
      }

      // Handle tool result
      if (message.type === "user") {
        const msg = message as SDKUserMessage;
        if (msg.message.role === "user" && Array.isArray(msg.message.content)) {
          for (let c of msg.message.content) {
            if (
              c.type === "tool_result" &&
              c.tool_use_id &&
              opts.isAborted(c.tool_use_id)
            ) {
              logger.debug("[claudeRemote] Tool aborted, exiting claudeRemote");
              logger.debug(
                `${debugPrefix} tool aborted via tool_result; exiting stream loop`
              );
              return;
            }
          }
        }
      }
    }
    logger.debug(`${debugPrefix} response stream exhausted`);
  } catch (e) {
    if (e instanceof AbortError) {
      logger.debug(`[claudeRemote] Aborted`);
      // Ignore
    } else {
      logger.debug(`${debugPrefix} response stream error`, e);
      throw e;
    }
  } finally {
    logger.debug(
      `${debugPrefix} finally ` +
        `(streamMessages=${streamMessageSeq}, results=${resultSeq}, nextFetches=${nextMessageFetchSeq}, inputEnded=${inputEnded})`
    );
    updateThinking(false);
    // #1734: restore process.env for every key opts.claudeEnvVars overwrote, so
    // a binding var (e.g. CLAUDE_CODE_OAUTH_TOKEN) does not persist into a later
    // same-process spawn (research code-review #3).
    for (const [key, prior] of claudeEnvVarsPrior) {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    if (safeModeHelperSettingsPath) {
      cleanupHookSettingsFile(safeModeHelperSettingsPath);
    }
  }
}
