# You are running inside Hapimatic

**Hapimatic is a web/PWA harness that wraps your Claude Code session.** The user reaches you from a
browser or a phone (installed as a PWA), not from a local terminal. Everything Claude Code can do,
you can do here — **plus** the Hapimatic-native capabilities below. Your job is not only to
_describe_ these when asked, but to **infer and execute** them from a user's plain-language request,
without the user naming the mechanism.

> **Is this doc current?** `hapimatic-version` above is the Hapimatic release this node was last
> provisioned/reconciled at. If it looks far behind the running server (`hapi api version`, or
> `curl -s localhost:3008/api/version`), treat this doc as possibly stale and prefer live checks.
> Stale self-knowledge is worse than none — say so rather than assert confidently.

## Guaranteed MCP tool guardrails

Hapimatic injects a small MCP server into every session; the three tools it registers
(`change_title`, `image_fetch`, `register_service_key`) are always available — you never need to
check whether they exist. Two carry security rules that do not fit a one-line capability entry and
must survive here in full:

- **`image_fetch`** rejects `file://`, `data:`, `localhost`, and private IPs — for something you
  generated locally, render it (HTML → local screenshot) and let the screenshot surface inline
  instead of publishing just to fetch it.
- **`register_service_key`** — capture ONLY the provider (+ optional label/baseUrl/model), **never
  the secret itself**. The user types the secret directly into the secure card; it goes straight to
  the server and never passes through the conversation, your context, or the transcript. Never ask
  the user to paste a raw key into chat.

## What Hapimatic adds over stock Claude Code

Stock `claude` is a local terminal REPL. On a Hapimatic node you additionally have:

- **Remote web/PWA access** — the user drives you from any device; installable as an app with push
  notifications. There is a **terminal view** in the UI for watching command output.
- **The three guaranteed MCP tools** above (inline images, chat titles, secure key entry).
- **Session spawning & orchestration** — spawn independent peer Claude Code sessions (see below).
- **File uploads** — files the user attaches in the UI land on the filesystem under
  `UserFileUploads/` in the session's working directory; read them directly.
- **A persistent server + preferences** — Hapimatic runs as a long-lived service (systemd), so
  sessions and settings persist across page reloads and reconnects. User-facing preferences live in
  the web UI's settings.

## What Hapimatic is vs Claude "Cowork" sandbox

Claude's **Cowork** mode is an ephemeral sandbox: it resets per session, has no persistent
filesystem, and no root. **A Hapimatic node is the opposite** — a persistent machine you return to:
a real filesystem that keeps state between sessions, long-running systemd services, a web UI, and
the ability to spawn peer sessions. Work here is durable, not scratch.

## Session orchestration

A Hapimatic session is an independent Claude Code process with its own context window and tool
access. From within one you can drive others:

- `hapi api sessions list` — all sessions on this node (+ their state)
- `hapi api sessions spawn --dir <path>` — start a new independent session
- `hapi api sessions send <id> "<prompt>"` — send a prompt to a session
- `hapi api sessions messages <id>` — read a session's output/progress
- `hapi api sessions abort <id>` — stop a running session

Judgment when you use them:

- A spawned peer **survives after the spawning session ends** and is **observable in the web UI**.
- There is a **concurrent-session cap** (default 10) sized for the node's resources; if a spawn is
  rejected as "too many concurrent sessions", list sessions and clean up finished ones first —
  don't retry-loop.
- Prefer a peer session (not a one-shot subagent) for non-trivial work that should outlive the
  current turn or that the user should be able to watch.

## Where things live

| Thing                          | Location                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Hapimatic binary               | `~/.local/bin/hapimatic-private`; `hapi` = `~/.local/bin/hapi`, rp1-home `bin/hapi` shim (byte-identical, rp1-home#2332)   |
| Instance data & settings       | `~/.hapimatic-private/` (`settings.json`, session state, DB)                                                               |
| Claude config (incl. this doc) | `~/.claude/` — this file is `~/.claude/agent-self-knowledge.md`, loaded via a managed `@`-include in `~/.claude/CLAUDE.md` |
| Uploaded files                 | `UserFileUploads/` under the session's working directory                                                                   |
| Web UI / API                   | the node's Hapimatic URL → Caddy → server on `localhost:3008`                                                              |
| Service management             | `systemctl --user status hapimatic-private hapimatic-private-daemon`                                                       |

## Update model (and why staleness matters)

The Hapimatic binary and this self-knowledge doc are **pushed to this node from the provisioning
host** — the node does not pull its own updates by default. New versions arrive when the node is
re-provisioned or reconciled (`scripts/provision.sh` / `scripts/reconcile-vm.sh`). Each push
re-stamps `hapimatic-version` above. If that stamp trails the running server version, this doc may
describe an older Hapimatic — flag the mismatch instead of asserting confidently.
