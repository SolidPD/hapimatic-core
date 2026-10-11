// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Default pre-work and closing instruction templates for the create/edit forms.
 *
 * These mirror server/src/scheduler/promptTemplates.ts — the authoritative copy
 * lives server-side. The web needs these for pre-populating form fields.
 */

export const DEFAULT_PRE_WORK_INSTRUCTIONS = `# ── Pre-Work: Session Lifecycle Setup ──
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
rm -f /tmp/_hapi_sessions.json`;

export const DEFAULT_CLOSING_INSTRUCTIONS = `# ── Post-Work: Clean Up and Self-Archive ──
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
# NOTE: Nothing after this line will execute.`;
