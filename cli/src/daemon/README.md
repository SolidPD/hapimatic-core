# HAPI CLI Daemon: Control Flow and Lifecycle

The daemon is a persistent background process that manages HAPI sessions and enables remote control from the mobile app. Upgrades come from the deploy flows restarting its unit (see "Build Version & Upgrades").

## 1. Daemon Lifecycle

### Starting the Daemon

Command: `hapi daemon start`

Control Flow:

1. `src/index.ts` receives `daemon start` command
2. Spawns detached process via `spawnHappyCLI(['daemon', 'start-sync'], { detached: true })`
3. New process calls `startDaemon()` from `src/daemon/run.ts`
4. `startDaemon()` performs startup:
   - Sets up shutdown promise and handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
   - Already-running check: `readDaemonBuildSkew()` (`controlClient.ts`). A live daemon for this `HAPI_HOME` is never stopped or replaced, whatever build it recorded (#4594, D-4594-1 A): `start-sync` exits 0 with "Daemon already running" and logs a build skew if there is one. `hapi daemon start` from a terminal prints the same and does not spawn `start-sync`.
   - Lock acquisition: `acquireDaemonLock()` creates exclusive lock file to prevent multiple daemons
   - Direct-connect setup: `authAndSetupMachineIfNeeded()` ensures `CLI_API_TOKEN` is set and `machineId` exists
   - State persistence: writes PID, version, HTTP port, mtime to daemon.state.json
   - HTTP server: starts Fastify on random port for local CLI control (list, stop, spawn)
   - WebSocket: establishes persistent connection to backend via `ApiMachineClient`
   - RPC registration: exposes `spawn-happy-session`, `stop-session`, `stop-daemon` handlers
   - Heartbeat loop: every 60s (or `HAPI_DAEMON_HEARTBEAT_INTERVAL`) prunes dead sessions and verifies PID ownership (no build check; see "Build Version & Upgrades")
5. Awaits shutdown promise which resolves when:
   - OS signal received (SIGINT/SIGTERM) - source: `os-signal`
   - HTTP `/stop` endpoint called - source: `hapi-cli`
   - RPC `stop-daemon` invoked - source: `hapi-app`
   - Uncaught exception occurs - source: `exception`
6. On shutdown, `cleanupAndShutdown()` performs:
   - Clears heartbeat interval
   - Updates daemon state to "shutting-down" on backend with shutdown source
   - Disconnects WebSocket
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
   - Exits process

### Systemd Invariants Self-Check

After the already-running check and before `acquireDaemonLock()`, the daemon
validates its own systemd unit against four invariants required to keep
tmux/Claude sessions alive across daemon restarts (see [hapimatic-private#418]):

| Invariant  | Required value                              | Why it matters                                                                      |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `KillMode` | `process`                                   | Default `control-group` SIGTERMs the cgroup → kills tmux server and Claude sessions |
| `Wants=`   | contains a token starting with `hapimatic-` | Loose dependency on the parent server unit (no cascade)                             |
| `PartOf=`  | empty                                       | Forbidden — would cascade-restart the daemon when the server restarts               |
| `BindsTo=` | empty                                       | Forbidden — would cascade-stop the daemon when the server stops                     |

Implementation: `cli/src/daemon/systemdInvariants.ts`. The check parses
`/proc/self/cgroup` to discover its own unit name (excluding `user@<uid>.service`
ancestors) and runs `systemctl --user show <unit> --property=KillMode,PartOf,BindsTo,Wants`.

**Default behavior**: log a warning via `logger.warn()` + `logger.reportError({category: "systemd-invariants"})`
if any invariant fails. The daemon continues starting up.

**Opt-in strict mode**: set `HAPI_DAEMON_ENFORCE_SYSTEMD_INVARIANTS=1` (or `true`/`yes`)
to escalate the warning to a refusal-to-start (`process.exit(1)` BEFORE the lock is claimed,
so a refusal does not orphan the lock file).

**Graceful no-op** when running outside systemd (macOS, Windows, dev shells, CI runners
without `/proc/self/cgroup` or without `systemctl` on PATH). Internal failures of the
check itself never abort the daemon — only the explicit env-var opt-in path may exit.

This is the **runtime drift gate** (Option C in the original design). It complements
the [rp1-home#472 CI gate] (Option A) which validates the same invariants at commit
time. Together they close the regression loop: A catches commits, C catches manual
drift on the live system.

[hapimatic-private#418]: https://github.com/MattStarfield/hapimatic-private/issues/418
[rp1-home#472]: https://github.com/MattStarfield/rp1-home/issues/472

### Build Version & Upgrades (#4594)

The CLI's version is the build's root `package.json` version, read from `server/src/version.generated.ts` through `cli/src/version.ts` (`CLI_VERSION`); `cli/package.json`'s `0.6.0` is never read. The daemon records it at boot as `startedWithCliVersion` (plus `startedWithCliMtimeMs`, which no code acts on since #4590; `hapi doctor` still prints it with the record).

Upgrades are the deploy flows' job: they replace the binary and restart the daemon's systemd unit (prod deploy script, `deploy-local.sh` + the closer's daemon restart, `worktree-build.sh --restart`, `deploy-node.sh`). No CLI command replaces a running daemon because its build differs (D-4594-1 A):

1. `daemon start` / `daemon start-sync` see a live daemon of another build, leave it running and report the skew; `hapi claude` (including a daemon-spawned session) only skips starting a second daemon, and reports the skew: always in its debug log, and on the console when it was started from a terminal (#5103).
2. `hapi doctor` / `hapi daemon status` print the daemon's recorded build and, when it differs from the CLI's, a "Build skew" line naming the older side.

The heartbeat has no build check (#4590): a running daemon keeps its build until its unit restarts, whatever binary is installed meanwhile.

### Heartbeat System

Every 60 seconds (configurable via `HAPI_DAEMON_HEARTBEAT_INTERVAL`):

1. **Guard**: Skips if previous heartbeat still running (prevents concurrent heartbeats)
2. **Session Pruning**: Checks each tracked PID with `isProcessAlive(pid)`, removes dead sessions
3. **PID Ownership**: Verifies daemon still owns state file, self-terminates if another daemon took over
4. **State Update**: Writes `lastHeartbeat` timestamp to daemon.state.json

### Stopping the Daemon

Command: `hapi daemon stop`

Control Flow:

1. `stopDaemon()` in `controlClient.ts` reads daemon.state.json
2. Attempts graceful shutdown via HTTP POST to `/stop`
3. Daemon receives request, triggers shutdown with source `hapi-cli`
4. `cleanupAndShutdown()` executes:
   - Updates backend status to "shutting-down"
   - Closes WebSocket connection
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
5. If HTTP fails, falls back to `killProcess(pid, true)` (uses `taskkill /T /F` on Windows)

## 2. Multi-Agent Support

The daemon supports spawning sessions with different AI agents:

| Agent              | Command       | Token Environment                                                                      |
| ------------------ | ------------- | -------------------------------------------------------------------------------------- |
| `claude` (default) | `hapi claude` | `HAPI_ACCOUNT_UUID` (bound) or the node's instance `CLAUDE_CODE_OAUTH_TOKEN` (unbound) |
| `codex`            | `hapi codex`  | `CODEX_HOME` (temp directory with `auth.json`)                                         |
| `gemini`           | `hapi gemini` | -                                                                                      |

### Token Authentication

When spawning a session:

- **Claude, account-bound**: the daemon sets `HAPI_ACCOUNT_UUID`; the wrapper resolves it to an isolated `CLAUDE_CONFIG_DIR` or an explicit `CLAUDE_CODE_OAUTH_TOKEN` (`withAccountToken`) and passes ONLY that explicit binding to the `claude` child — ambient binding vars are stripped (issue #3731).
- **Claude, host-default** (the selected account is the host's own `~/.claude` login): the daemon sets neither `HAPI_ACCOUNT_UUID` nor a token — native Claude Code uses the host credentials (issue #1507).
- **Claude, unbound** (no account selected, no host-default login): the daemon delivers the node's instance credential — the onboarding `CLAUDE_CODE_OAUTH_TOKEN` it captured at boot (`ctx.instanceOAuthToken`) — on the tmux arm via the 0600 spawn env file, on the direct arm via the child's spawn env. After the boot seed stores the primary account, the daemon deletes the AMBIENT copy from its own env, so no tmux server or child inherits it, and records the outcome in `daemon.state.json` for `hapi doctor` (#3731).
- **Claude, explicit token**: a `token` passed with the spawn request is set as `CLAUDE_CODE_OAUTH_TOKEN` and wins over the instance credential on both arms (#3731).
- **Codex**: Creates temp directory at `os.tmpdir()/hapi-codex-*`, writes token to `auth.json`, sets `CODEX_HOME`

## 3. Session Management

### Daemon-Spawned Sessions (Remote)

Initiated by mobile app via backend RPC:

1. Backend forwards RPC `spawn-happy-session` to daemon via WebSocket
2. `ApiMachineClient` invokes `spawnSession()` handler
3. `spawnSession()`:
   - Validates/creates directory (with approval flow)
   - Configures agent-specific token environment
   - Spawns detached HAPI process with `--hapi-starting-mode remote --started-by daemon`
   - Adds to `pidToTrackedSession` map
   - Sets up 15-second awaiter for session webhook
4. New HAPI process:
   - Creates session with backend, receives `happySessionId`
   - Calls `notifyDaemonSessionStarted()` to POST to daemon's `/session-started`
5. Daemon updates tracking with `happySessionId`, resolves awaiter
6. RPC returns session info to mobile app

### Terminal-Spawned Sessions

User runs `hapi` directly:

1. CLI auto-starts daemon if configured
2. HAPI process calls `notifyDaemonSessionStarted()`
3. Daemon receives webhook, creates `TrackedSession` with `startedBy: 'hapi directly - likely by user from terminal'`
4. Session tracked for health monitoring

### Directory Creation Approval

When spawning a session, directory handling:

1. Check if directory exists with `fs.access()`
2. If missing and `approvedNewDirectoryCreation = false`: returns `requestToApproveDirectoryCreation` (HTTP 409)
3. If missing and approved: creates directory with `fs.mkdir({ recursive: true })`
4. Error handling for directory creation:
   - `EACCES`: Permission denied
   - `ENOTDIR`: File exists at path
   - `ENOSPC`: Disk full
   - `EROFS`: Read-only filesystem

### Session Termination

Via RPC `stop-session` or HTTP `/stop-session`:

1. `stopSession()` finds session by `happySessionId` or `PID-{pid}` format
2. Sends termination request via `killProcessByChildProcess()` or `killProcess()` (Windows uses `taskkill /T`)
3. `on('exit')` handler removes from tracking map

## 4. HTTP Control Server (Fastify)

Local HTTP server using Fastify with `fastify-type-provider-zod` for type-safe request/response validation.

**Host:** 127.0.0.1 (localhost only)
**Port:** Dynamic (system-assigned)
**Auth:** Bearer token (issue #1738). The daemon generates a 256-bit token at
startup, persists it to `daemon.state.json` (`controlToken`), and a global
fail-closed `onRequest` hook requires `Authorization: Bearer <controlToken>` on
**every** endpoint (constant-time compared via `constantTimeEquals`). The
`127.0.0.1` bind stays as the first trust boundary; the token is a
defense-in-depth second layer over the mutating `/force-refresh-account`
endpoint. The in-tree client (`controlClient.ts` `daemonPost`) reads the token
from the same state file and attaches it automatically; any external caller must
do the same.

### Endpoints

#### POST `/session-started`

Session webhook - reports itself after creation.

**Request:**

```json
{ "sessionId": "string", "metadata": { ... } }
```

**Response (200):**

```json
{ "status": "ok" }
```

#### POST `/list`

Returns all tracked sessions.

**Response (200):**

```json
{
  "children": [
    { "startedBy": "daemon", "happySessionId": "uuid", "pid": 12345 }
  ]
}
```

#### POST `/stop-session`

Terminates a specific session.

**Request:**

```json
{ "sessionId": "string" }
```

**Response (200):**

```json
{ "success": true }
```

#### POST `/spawn-session`

Creates a new session.

**Request:**

```json
{ "directory": "/path/to/dir", "sessionId": "optional-uuid" }
```

**Response (200) - Success:**

```json
{
  "success": true,
  "sessionId": "uuid",
  "approvedNewDirectoryCreation": true
}
```

When a spawn with no `sessionType` defaulted to a worktree but ran as a simple
session because git is missing or could not read the folder, or its branch-from
HEAD has no commits, the body also carries the reason (#5202, #5614):

```json
{
  "sessionTypeDowngrade": {
    "from": "worktree",
    "to": "simple",
    "reason": "the branch-from HEAD at '/path' has no commits yet"
  }
}
```

The designed `not-a-repo` downgrade of a scratch folder stays silent.

**Response (409) - Requires Approval:**

```json
{
  "success": false,
  "requiresUserApproval": true,
  "actionRequired": "CREATE_DIRECTORY",
  "directory": "/path/to/dir"
}
```

**Response (500) - Error:**

```json
{ "success": false, "error": "Error message", "code": "at_capacity" }
```

`code` is optional; it classifies the error without string-matching (#1772).

#### POST `/stop`

Graceful daemon shutdown.

**Response (200):**

```json
{ "status": "stopping" }
```

## 5. State Persistence

### daemon.state.json

```json
{
  "pid": 12345,
  "httpPort": 50097,
  "startTime": "8/24/2025, 6:46:22 PM",
  "startedWithCliVersion": "0.9.0-6",
  "startedWithCliMtimeMs": 1724531182000,
  "lastHeartbeat": "8/24/2025, 6:47:22 PM",
  "daemonLogPath": "/path/to/daemon.log"
}
```

### Lock File

- Created with O_EXCL flag for atomic acquisition
- Contains PID for debugging
- Prevents multiple daemon instances
- Cleaned up on graceful shutdown

## 6. WebSocket Communication

`ApiMachineClient` handles bidirectional communication:

**Daemon to Server:**

- `machine-alive` - 20-second heartbeat
- `machine-update-metadata` - static machine info changes
- `machine-update-state` - daemon status changes

**Server to Daemon:**

- `rpc-request` with methods:
  - `spawn-happy-session` - spawn new session
  - `stop-session` - stop session by ID
  - `stop-daemon` - request shutdown

All data is plain JSON over TLS; authentication is `CLI_API_TOKEN` (no end-to-end encryption).

## 7. Process Discovery and Cleanup

### Doctor Command

`hapi doctor` and `hapi daemon status` list processes with `ps-list` and type each one by its executable token and
the arguments after it (`classifyHappyProcess` in `doctor.ts`), not by a substring of the whole command line, so a
shell wrapper that merely mentions `hapi daemon start` is not a hapi process (#5180):

- Production: the `hapi` / `hapi.exe` binary, plus the running binary's own name. A fleet instance's binary is named per
  instance (`hapimatic-private`, `hapimatic-dev`, `hapimatic-wt-3012`), so each lists its own processes and any
  `hapi`-named process, but no other `hapimatic-*` instance's (`instanceExecutableNames`, #5526).
- Development: `bun` / `node` running the CLI's own entry, a path ending in `cli/src/index.ts`. Another project's
  `src/index.ts` is not hapi (#5763).
- Legacy `happy-coder`: its `happy` binary, or `node` running a script path inside the `happy-coder` / `happy-cli`
  package. A command line that only carries the word `happy-coder` (`ssh h happy-coder daemon start`) is not hapi
  (#5763).
- Types by command args: daemon, daemon-spawned session, server, doctor, user-session. A version check is a process
  whose only argument is `--version`: `ps` joins argv with spaces, so a `--version` word inside a prompt does not make a
  session a version check (#5763).
- The value of any `--token` / `--*-token` argument prints as `<redacted>` (#5526)
- A failed `ps-list` call is reported as `Could not list processes: <reason>`, not read as "No hapi processes found"
  (#5763).

### Clean Runaway Processes

`hapi doctor clean [--dry-run]` (`runDoctorClean` in `commands/doctor.ts`):

1. Options are checked first: `--dry-run` lists what would be killed and kills nothing; any other option (a typo such as
   `--dryrun` included) prints the usage and exits 2 before anything is listed or killed (#5763).
2. `findRunawayHappyProcesses()` selects the daemon, daemon-spawned sessions and stuck `--version` checks. It matches
   only `hapi` / `hapi.exe` (plus dev mode and the legacy binaries), never the running binary's own name, so it never
   reaches a `hapimatic-*` instance's daemon or sessions (#5526)
3. `killRunawayHappyProcesses()`:
   - Sends SIGTERM
   - Waits 1 second
   - Sends SIGKILL if still alive
   - Counts a process as killed only when a signal reached it. `killProcess` returns false both for a process that
     already exited and for one this user may not signal (EPERM), so a false return is checked against the process
     list: an exited process is reported as already exited, a live one is recorded as an error (#5763).
4. The command exits 1 when any kill failed or the process list could not be read, and 0 otherwise (#5763).

## 8. Integration Testing

### Test Environment

- Requires `.env.integration-test`
- Uses local hapi-server (http://localhost:3006)
- Separate `~/.hapi-dev-test` home directory

### Key Test Scenarios

- Session listing, spawning, stopping
- External session webhook tracking
- Graceful SIGTERM/SIGKILL shutdown
- Multiple daemon prevention
- A live daemon of another build is kept and the skew is reported
- Directory creation approval flow
- Concurrent session stress tests

---

# Machine Sync Architecture - Separated Metadata & Daemon State

> Direct-connect note: the "server" is `hapi-server`, payloads are plain JSON (no base64/encryption),
> and authentication uses `CLI_API_TOKEN` (REST `Authorization: Bearer ...` + Socket.IO `handshake.auth.token`).

## Data Structure (Similar to Session's metadata + agentState)

```typescript
// Static machine information (rarely changes)
interface MachineMetadata {
  host: string; // hostname
  platform: string; // darwin, linux, win32
  happyCliVersion: string;
  homeDir: string;
  happyHomeDir: string;
  happyLibDir: string; // runtime path
}

// Dynamic daemon state (frequently updated)
interface DaemonState {
  status: "running" | "shutting-down" | "offline";
  pid?: number;
  httpPort?: number;
  startedAt?: number;
  shutdownRequestedAt?: number;
  shutdownSource?: "hapi-app" | "hapi-cli" | "os-signal" | "exception";
}
```

## 1. CLI Startup Phase

Checks if machine ID exists in settings:

- If not: creates ID locally only (so sessions can reference it)
- Does NOT create machine on server - that's daemon's job
- CLI doesn't manage machine details - all API & schema live in daemon subpackage

## 2. Daemon Startup - Initial Registration

### REST Request: `POST /cli/machines`

```json
{
  "id": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "happyCliVersion": "1.0.0",
    "homeDir": "/Users/john",
    "happyHomeDir": "/Users/john/.hapi",
    "happyLibDir": "/usr/local/lib/node_modules/hapi"
  },
  "daemonState": {
    "status": "running",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567
  }
}
```

### Server Response:

```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "happyCliVersion": "..." },
    "metadataVersion": 1,
    "daemonState": { "status": "running", "pid": 12345 },
    "daemonStateVersion": 1,
    "active": true,
    "activeAt": 1703001234567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001234567
  }
}
```

## 3. WebSocket Connection & Real-time Updates

### Connection Handshake:

```javascript
io(`${botUrl}/cli`, {
  auth: {
    token: "CLI_API_TOKEN",
    clientType: "machine-scoped",
    machineId: "machine-uuid-123",
  },
  path: "/socket.io/",
  transports: ["websocket"],
});
```

### Heartbeat (every 20s):

```json
// Client -> Server
socket.emit('machine-alive', {
  "machineId": "machine-uuid-123",
  "time": 1703001234567
})
```

## 4. Daemon State Updates (via WebSocket)

### When daemon status changes:

```json
// Client -> Server
socket.emit('machine-update-state', {
  "machineId": "machine-uuid-123",
  "daemonState": {
    "status": "shutting-down",
    "pid": 12345,
    "httpPort": 8080,
    "startedAt": 1703001234567,
    "shutdownRequestedAt": 1703001244567,
    "shutdownSource": "hapi-app"
  },
  "expectedVersion": 1
}, callback)

// Server -> Client (callback)
// Success:
{
  "result": "success",
  "version": 2,
  "daemonState": { "status": "shutting-down" }
}

// Version mismatch:
{
  "result": "version-mismatch",
  "version": 3,
  "daemonState": { "status": "running" }
}
```

### Machine metadata update (rare):

```json
// Client -> Server
socket.emit('machine-update-metadata', {
  "machineId": "machine-uuid-123",
  "metadata": {
    "host": "MacBook-Pro.local",
    "platform": "darwin",
    "happyCliVersion": "1.0.1",
    "homeDir": "/Users/john",
    "happyHomeDir": "/Users/john/.hapi"
  },
  "expectedVersion": 1
}, callback)
```

## 5. Mini App RPC Calls (via hapi-server)

The Telegram Mini App calls REST endpoints on `hapi-server` (for example `POST /api/machines/:id/spawn`).
`hapi-server` then relays those requests to the daemon via Socket.IO `rpc-request` on the `/cli` namespace.

RPC method naming (machine-scoped) uses a `${machineId}:` prefix, for example:

- `${machineId}:spawn-happy-session`

## 6. Server Broadcasts to Clients

### When daemon state changes:

```json
// Server -> Mobile/Web clients
socket.emit('update', {
  "id": "update-id-xyz",
  "seq": 456,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "daemonState": {
      "value": { "status": "shutting-down" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

### When metadata changes:

```json
socket.emit('update', {
  "id": "update-id-abc",
  "seq": 457,
  "body": {
    "t": "update-machine",
    "machineId": "machine-uuid-123",
    "metadata": {
      "value": { "host": "MacBook-Pro.local" },
      "version": 2
    }
  },
  "createdAt": 1703001244567
})
```

## 7. GET Machine Status (REST)

### Request: `GET /cli/machines/machine-uuid-123`

```http
Authorization: Bearer <CLI_API_TOKEN>
```

### Response:

```json
{
  "machine": {
    "id": "machine-uuid-123",
    "metadata": { "host": "...", "platform": "...", "happyCliVersion": "..." },
    "metadataVersion": 2,
    "daemonState": { "status": "running", "pid": 12345 },
    "daemonStateVersion": 3,
    "active": true,
    "activeAt": 1703001244567,
    "createdAt": 1703001234567,
    "updatedAt": 1703001244567
  }
}
```

## Key Design Decisions

1. **Separation of Concerns**:
   - `metadata`: Static machine info (host, platform, versions)
   - `daemonState`: Dynamic runtime state (status, pid, ports)

2. **Independent Versioning**:
   - `metadataVersion`: For machine metadata updates
   - `daemonStateVersion`: For daemon state updates
   - Allows concurrent updates without conflicts

3. **Security**: No end-to-end encryption (TLS only); CLI auth is a shared secret `CLI_API_TOKEN`

4. **Update Events**: Server broadcasts use same pattern as sessions:
   - `t: 'update-machine'` with optional metadata and/or daemonState fields
   - Clients only receive updates for fields that changed

5. **RPC Pattern**: Machine-scoped RPC methods prefixed with machineId (like sessions)

---

# Improvements

- daemon.state.json file is getting hard removed when daemon exits or is stopped. We should keep it around and have 'state' field and 'stateReason' field that will explain why the daemon is in that state
- If the file is not found - we assume the daemon was never started or was cleaned out by the user or doctor
- If the file is found and corrupted - we should try to upgrade it to the latest version? or simply remove it if we have write access

- posts helpers for daemon do not return typed results
- I don't like that daemonPost returns either response from daemon or { error: ... }. We should have consistent envelope type

- we loose track of children processes when daemon exits / restarts - we should write them to the same state file? At least the pids should be there for doctor & cleanup

- the daemon control server binds to `127.0.0.1` on a random port AND (issue #1738) requires a bearer token on every request (see § 4 "Auth"); the localhost bind remains the first trust boundary
