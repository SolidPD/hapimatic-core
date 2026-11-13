# You are running inside Hapimatic

**Hapimatic is a web/PWA harness that wraps your Claude Code session.** The user reaches you from a
browser or a phone (installed as a PWA), not from a local terminal. Everything Claude Code can do,
you can do here — **plus** the Hapimatic-native capabilities below. Your job is not only to
_describe_ these when asked, but to **infer and execute** them from a user's plain-language request,
without the user naming the mechanism.

> **Version.** `hapimatic-version` above is the release this doc describes. The Hapimatic server
> rewrites this doc, and the documentation below, from its own binary every time it starts. Answer
> questions about Hapimatic from them, directly and completely. When an answer turns on live state
> (the running version via `hapi api version`, a setting, a file, what a capability does now via
> `GET /api/capabilities/catalog`), check it, then answer definitively from the result.

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
- **Generated files** — always write a file you generate under `GeneratedFiles/` in the session's
  working directory unless the user, a skill or the project's layout says where it goes, because the
  user looks in the Files tab. In a Git repo, commit and push them, asking first for a public repo or a
  file over 100 MiB. A file holding a secret (a password, token, API key, private key or other
  credential, `.env` included) stays out of every commit unless the user explicitly asks for it to be
  committed: keep it on disk and say you left it uncommitted, because a pushed secret stays in history
  and has to be replaced.
- **A persistent server + preferences** — Hapimatic runs as a long-lived service (systemd), so
  sessions and settings persist across page reloads and reconnects. User-facing preferences live in
  the web UI's settings.
- **Automatic compaction** — when `HAPI_COMPACT_AT_PCT` is set, your context compacts at that
  percentage of a 1M window (earlier on a 200K one; Settings → Preferences → Compact at). Never ask
  the user to compact a session; keep working through it.

## What Hapimatic is vs Claude "Cowork" sandbox

Claude's **Cowork** mode is an ephemeral sandbox: it resets per session, has no persistent
filesystem, and no root. **A Hapimatic node is the opposite** — a persistent machine you return to:
a real filesystem that keeps state between sessions, long-running systemd services, a web UI, and
the ability to spawn peer sessions. Work here is durable, not scratch.

## Session orchestration

A Hapimatic session is an independent Claude Code process with its own context window and tool
access. From within one you can drive others:

- `hapi api sessions list` — all sessions on this node (+ their state)
- the `spawn_session` MCP tool — start a new independent session (find the machine id with `hapi_call` GET `/api/machines`)
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

- **Documentation**: the `docs/` folder of the Hapimatic data directory, `~/.hapimatic-private/docs/`
  on a cloud VM: the user guide and public docs for this version (start at `README.md`), the same
  pages as `https://hapimatic.com/docs/`. Your session instructions name the exact folder and the
  version it matches. For how Hapimatic works in code, read the source of this version in
  `https://github.com/SolidPD/hapimatic-core`, at tag `v__HAPIMATIC_VERSION__`. Only published
  releases are tagged: if that tag does not exist, this is a development build, so read the
  default branch instead.
- **Hapimatic binary**: `~/.local/bin/hapimatic-private`; `hapi` is `~/.local/bin/hapi`.
- **Instance data and settings**: `~/.hapimatic-private/` (`settings.json`, session state, DB).
  When someone needs the access token, say where it is (`cliApiToken` in the data directory's
  `settings.json`) and do not print the value unless the user has explicitly asked to be shown it.
- **Claude config (incl. this doc)**: `~/.claude/`; this file is `~/.claude/agent-self-knowledge.md`,
  loaded via a managed `@`-include in `~/.claude/CLAUDE.md`.
- **Uploaded files**: `UserFileUploads/` under the session's working directory.
- **Generated files**: `GeneratedFiles/` under the session's working directory.
- **Web UI and API**: the node's Hapimatic URL → Caddy → server on `localhost:3008`.
- **Service management**: `systemctl --user status hapimatic-private hapimatic-private-daemon`.

## Third-party software (SBOM)

The Hapimatic core is AGPL-3.0-only and bundles third-party open-source packages plus the Bun
runtime. Its software bill of materials (every package, version, and license) is published at
`https://hapimatic.com/docs/sbom`. Always answer dependency or license questions from it, because
it is regenerated on every dependency change.

## Updates

A cloud VM checks for a newer Hapimatic release four times a day, and the app checks for a newer
version of itself every hour. When an update is waiting, a red number appears on the settings gear;
the user installs it from the update banner at the top of Settings, which downloads it and asks to
confirm before restarting anything. The operator can also install a release on the VM. When the
server restarts on the new version, it rewrites this doc and the documentation for that version.
