// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Default Pre-Work and Closing Instructions for Scheduled Tasks
 *
 * These templates provide lifecycle management for non-heartbeat scheduled sessions:
 *   - Pre-work: authenticate, create guard file, resolve session UUID, clean stale sessions
 *   - Closing: remove guard file, re-authenticate, self-archive
 *
 * Environment variables (set by tmuxSpawnAdapter.ts):
 *   HAPI_SESSION_ID — unique session tag
 *   HAPI_HOME       — data directory path (e.g., ~/.hapimatic-dev)
 *   HAPI_SERVER_URL  — server URL (e.g., http://localhost:3009)
 */

import type { ScheduledTask } from "./types";

export const DEFAULT_PRE_WORK_INSTRUCTIONS = `
# ── Pre-Work: Session Lifecycle Setup ──
# Authenticates, signals active state, and cleans up stale sessions from previous cycles.

# 1. Authenticate with Hapimatic API
TOKEN=$(python3 -c "import json; print(json.load(open('\${HAPI_HOME}/settings.json'))['cliApiToken'])")
curl -s -X POST \${HAPI_SERVER_URL}/api/auth -H "Content-Type: application/json" \\
    -d "{\\"accessToken\\": \\"$TOKEN\\"}" > /tmp/_hapi_auth.json
JWT=$(python3 -c "import json; print(json.load(open('/tmp/_hapi_auth.json')).get('token',''))")
rm -f /tmp/_hapi_auth.json

# 2. Create guard file (signals this session is actively working)
GUARD_FILE="/tmp/_hapi_task_done_\${HAPI_SESSION_ID}"
touch "$GUARD_FILE"

# 3. Resolve own session UUID and scheduleId
curl -s -H "Authorization: Bearer $JWT" \${HAPI_SERVER_URL}/api/sessions > /tmp/_hapi_sessions.json
read MY_UUID MY_SCHEDULE_ID <<< $(python3 -c "
import json, os
tag = os.environ.get('HAPI_SESSION_ID', '')
d = json.load(open('/tmp/_hapi_sessions.json'))
for s in d.get('sessions', []):
    if s.get('tag') == tag:
        meta = s.get('metadata') or {}
        print(s['id'], meta.get('scheduleId', ''))
        break
")

# 4. Clean up archived sessions from previous cycles of the same task
if [ -n "$MY_SCHEDULE_ID" ]; then
    STALE_IDS=$(python3 -c "
import json, os
my_tag = os.environ.get('HAPI_SESSION_ID', '')
schedule_id = '$MY_SCHEDULE_ID'
d = json.load(open('/tmp/_hapi_sessions.json'))
ids = []
for s in d.get('sessions', []):
    if s.get('tag') == my_tag: continue       # Skip self
    if s.get('active'): continue              # Skip active sessions
    meta = s.get('metadata') or {}
    if meta.get('scheduleId') != schedule_id: continue  # Different task
    # Check if peer still has a guard file (might still be wrapping up)
    peer_tag = s.get('tag', '')
    if peer_tag and os.path.exists('/tmp/_hapi_task_done_' + peer_tag): continue
    ids.append(s['id'])
print(' '.join(ids))
")
    if [ -n "$STALE_IDS" ]; then
        for SID in $STALE_IDS; do
            curl -s -X DELETE -H "Authorization: Bearer $JWT" "\${HAPI_SERVER_URL}/api/sessions/$SID" > /dev/null
        done
    fi
fi
rm -f /tmp/_hapi_sessions.json
`.trim();

export const DEFAULT_CLOSING_INSTRUCTIONS = `
# ── Post-Work: Clean Up and Self-Archive ──
# Removes guard file, then terminates this scheduled session.

# 1. Clean up guard file
GUARD_FILE="/tmp/_hapi_task_done_\${HAPI_SESSION_ID}"
rm -f "$GUARD_FILE"

# 2. Authenticate with Hapimatic API
TOKEN=$(python3 -c "import json; print(json.load(open('\${HAPI_HOME}/settings.json'))['cliApiToken'])")
curl -s -X POST \${HAPI_SERVER_URL}/api/auth -H "Content-Type: application/json" \\
    -d "{\\"accessToken\\": \\"$TOKEN\\"}" > /tmp/_hapi_auth.json
JWT=$(python3 -c "import json; print(json.load(open('/tmp/_hapi_auth.json')).get('token',''))")
rm -f /tmp/_hapi_auth.json

# 3. Resolve this session's UUID
curl -s -H "Authorization: Bearer $JWT" \${HAPI_SERVER_URL}/api/sessions > /tmp/_hapi_sessions.json
MY_UUID=$(python3 -c "
import json, os
tag = os.environ.get('HAPI_SESSION_ID', '')
d = json.load(open('/tmp/_hapi_sessions.json'))
for s in d.get('sessions', []):
    if s.get('tag') == tag:
        print(s['id'])
        break
")
rm -f /tmp/_hapi_sessions.json

if [ -z "$MY_UUID" ]; then
    echo "WARNING: Could not resolve session UUID. Archive skipped."
    exit 0
fi

# 4. Archive this session (terminates CLI process — MUST be last command)
curl -s -X POST -H "Authorization: Bearer $JWT" "\${HAPI_SERVER_URL}/api/sessions/$MY_UUID/archive"
# NOTE: Nothing after this line will execute.
`.trim();

/**
 * System-injected completion signal for one scheduled execution (#2701).
 *
 * Tells the session to POST the completion endpoint once its work is done, so
 * the reaper frees its concurrency slot promptly instead of waiting out a
 * runtime ceiling. The session must call it BEFORE any closing/self-archive
 * step: the web's default closing block archives the session, after which
 * nothing else runs (review finding 2701-4).
 *
 * Auth mirrors the closing template above: `CLI_API_TOKEN` when the spawn env
 * carries it, otherwise the instance's `settings.json` (the OmniBox sandbox
 * strips `CLI_API_TOKEN` from the agent env), exchanged for a JWT because
 * every `/api` route requires one. `sessionTag` is `HAPI_SESSION_ID`, which
 * the server compares with the execution's session tag.
 *
 * Phrased as an explicit imperative with a fenced command: a live run showed a
 * session reading bare bash comments as context and never executing them.
 */
export function buildCompletionInstruction(executionId: string): string {
  return `
## Scheduler completion signal — REQUIRED final action

When the task above is complete, and BEFORE you run any closing or
self-archive step below, run this command ONCE with your Bash tool. It tells
the scheduler this session has finished so its slot can be freed. Do not skip
it, even if the task asked for a short reply.

\`\`\`bash
TOKEN="\${CLI_API_TOKEN:-$(python3 -c "import json; print(json.load(open('\${HAPI_HOME}/settings.json'))['cliApiToken'])")}"
JWT=$(curl -s -X POST \${HAPI_SERVER_URL}/api/auth -H "Content-Type: application/json" \\
    -d "{\\"accessToken\\": \\"$TOKEN\\"}" | python3 -c "import json, sys; print(json.load(sys.stdin).get('token', ''))")
curl -s -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \\
    -d "{\\"sessionTag\\": \\"\${HAPI_SESSION_ID}\\"}" \\
    "\${HAPI_SERVER_URL}/api/schedules/executions/${executionId}/complete"
\`\`\`
`.trim();
}

/**
 * Assemble the full prompt for a non-heartbeat scheduled spawn:
 * pre-work → task prompt → system completion signal → user closing block.
 * Null/empty user sections are omitted (no spurious separators).
 *
 * Heartbeat tasks reuse one persistent session and must never be told to
 * signal completion, so they are rejected outright (review finding 2701-3).
 */
export function assembleScheduledPrompt(
  task: ScheduledTask,
  executionId: string
): string {
  if (task.heartbeatMode) {
    throw new Error(
      `assembleScheduledPrompt: heartbeat task "${task.name}" must not receive a completion signal`
    );
  }
  const sections: string[] = [];
  if (task.preWorkInstructions?.trim()) {
    sections.push(task.preWorkInstructions.trim());
  }
  sections.push(task.prompt);
  sections.push(buildCompletionInstruction(executionId));
  if (task.closingInstructions?.trim()) {
    sections.push(task.closingInstructions.trim());
  }
  return sections.join("\n\n---\n\n");
}
