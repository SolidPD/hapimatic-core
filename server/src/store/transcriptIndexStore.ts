// SPDX-License-Identifier: AGPL-3.0-only
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
  TranscriptFilterOptions,
  TranscriptListQuery,
  TranscriptSummary,
} from "@hapi/protocol/schemas";
import { applyTranscriptIndexMigrations } from "./transcriptIndexMigrations";

/**
 * `transcripts.db` store (issue #3839) — the transcript-browser index.
 *
 * One row per Claude transcript (`<cfg>/projects/<slug>/<ccSessionId>.jsonl`),
 * keyed by the Claude session id, carrying the list/filter metadata plus the
 * SCRUBBED extracted text the FTS5 table indexes. Every string written to
 * `text` / `first_prompt` / `title` has already been through the scrub at the
 * indexer seam — this store never sees an unmasked token (R6).
 *
 * **Namespace scope (D27).** Rows carry the owning session's namespace when the
 * Hapimatic session row existed at index time. A row whose session was already
 * gone (an orphan) carries `namespace = NULL` and is visible ONLY to the node's
 * owning namespace — every read takes `{ namespace, isOwner }` and applies
 * `namespace = ? OR (namespace IS NULL AND isOwner)`. When the owning namespace
 * cannot be resolved the caller passes `isOwner: false` → orphans are hidden
 * (fail-closed).
 */

export interface TranscriptIndexRow {
  ccSessionId: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  namespace: string | null;
  hapiSessionId: string | null;
  hasSessionRow: boolean;
  firstUuid: string | null;
  title: string | null;
  cwd: string | null;
  gitBranch: string | null;
  repo: string | null;
  harness: string;
  account: string | null;
  linkedIssue: number | null;
  startedAtMs: number | null;
  lastActivityMs: number | null;
  messageCount: number;
  subagentCount: number;
  firstPrompt: string | null;
  /** Scrubbed extracted text runs — the FTS corpus. */
  text: string;
}

/** The caller's namespace scope for every read (D27). */
export interface NamespaceScope {
  namespace: string;
  /** True when the caller's namespace is the node's owning namespace. */
  isOwner: boolean;
}

/** The on-disk identity used to skip unchanged files (path + mtime + size). */
export interface IndexedFileKey {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

type DbRow = {
  cc_session_id: string;
  path: string;
  namespace: string | null;
  hapi_session_id: string | null;
  has_session_row: number;
  parent_cc_session_id: string | null;
  title: string | null;
  cwd: string | null;
  git_branch: string | null;
  repo: string | null;
  harness: string;
  account: string | null;
  linked_issue: number | null;
  started_at_ms: number | null;
  last_activity_ms: number | null;
  message_count: number;
  size_bytes: number;
  first_prompt: string | null;
  snippet?: string | null;
};

const SNIPPET_RADIUS = 80;

/**
 * Parse a user search string into terms: `"quoted phrases"` stay phrases,
 * bare words are individual terms. All terms must match (AND).
 */
export function parseSearchTerms(q: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const term = (m[1] ?? m[2] ?? "").trim();
    if (term) terms.push(term);
  }
  return terms;
}

/** FTS5 MATCH expression: every term as a quoted phrase, AND-joined. */
export function toFtsMatch(terms: string[]): string {
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, c => `\\${c}`);
}

/** LIKE-fallback snippet: the text around the first term's first match. */
function likeSnippet(text: string, terms: string[]): string | null {
  const lower = text.toLowerCase();
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at < 0) continue;
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(text.length, at + term.length + SNIPPET_RADIUS);
    const head = `${start > 0 ? "…" : ""}${text.slice(start, at)}`;
    const hit = text.slice(at, at + term.length);
    const tail = `${text.slice(at + term.length, end)}${end < text.length ? "…" : ""}`;
    return `${head}[${hit}]${tail}`;
  }
  return null;
}

function toSummary(row: DbRow): TranscriptSummary {
  return {
    ccSessionId: row.cc_session_id,
    hapiSessionId: row.hapi_session_id,
    hasSessionRow: row.has_session_row === 1,
    parentCcSessionId: row.parent_cc_session_id,
    title: row.title,
    cwd: row.cwd,
    gitBranch: row.git_branch,
    repo: row.repo,
    harness: row.harness,
    account: row.account,
    linkedIssue: row.linked_issue,
    startedAtMs: row.started_at_ms,
    lastActivityMs: row.last_activity_ms,
    messageCount: row.message_count,
    sizeBytes: row.size_bytes,
    firstPrompt: row.first_prompt,
    snippet: row.snippet ?? null,
  };
}

const SUMMARY_COLUMNS = `t.cc_session_id, t.path, t.namespace, t.hapi_session_id,
  t.has_session_row, t.parent_cc_session_id, t.title, t.cwd, t.git_branch, t.repo,
  t.harness, t.account, t.linked_issue, t.started_at_ms, t.last_activity_ms,
  t.message_count, t.size_bytes, t.first_prompt`;

const SCOPE_SQL = "(t.namespace = $ns OR (t.namespace IS NULL AND $owner = 1))";

export class TranscriptIndexStore {
  private readonly db: Database;
  readonly fts5: boolean;
  /** Lazily-loaded `getIndexedKeys()` cache (#4060); null until first read. */
  private keyCache: Map<string, IndexedFileKey> | null = null;

  constructor(dbPath: string, opts: { forceNoFts?: boolean } = {}) {
    const inMemory = dbPath === ":memory:";
    if (!inMemory) {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
      if (!existsSync(dbPath)) {
        try {
          closeSync(openSync(dbPath, "a", 0o600));
        } catch {
          // Creation falls through to bun:sqlite's own create below.
        }
      }
    }
    this.db = new Database(dbPath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.fts5 = applyTranscriptIndexMigrations(this.db, opts).fts5;
    if (!inMemory) {
      for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          chmodSync(p, 0o600);
        } catch {
          // WAL/SHM may not exist yet.
        }
      }
    }
  }

  /**
   * Every indexed file's identity, for the unchanged-file skip. Loaded once
   * and then kept in step by `upsert` / `deleteMany`, so the indexer's
   * per-pass check is not a full-table read on the server's main thread
   * (#4060). `reloadIndexedKeys()` re-reads it from the table.
   */
  getIndexedKeys(): ReadonlyMap<string, IndexedFileKey> {
    if (this.keyCache === null) this.keyCache = this.readIndexedKeys();
    return this.keyCache;
  }

  /** Discard the key cache and re-read it from the table (tests / recovery). */
  reloadIndexedKeys(): ReadonlyMap<string, IndexedFileKey> {
    this.keyCache = this.readIndexedKeys();
    return this.keyCache;
  }

  private readIndexedKeys(): Map<string, IndexedFileKey> {
    const rows = this.db
      .prepare(
        "SELECT cc_session_id, path, mtime_ms, size_bytes FROM transcripts"
      )
      .all() as Array<{
      cc_session_id: string;
      path: string;
      mtime_ms: number;
      size_bytes: number;
    }>;
    const out = new Map<string, IndexedFileKey>();
    for (const r of rows) {
      out.set(r.cc_session_id, {
        path: r.path,
        mtimeMs: r.mtime_ms,
        sizeBytes: r.size_bytes,
      });
    }
    return out;
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM transcripts")
      .get() as { n: number };
    return row.n;
  }

  /** Insert or replace one transcript row, then relink its resume chain. */
  upsert(row: TranscriptIndexRow, nowMs: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO transcripts (cc_session_id, path, mtime_ms, size_bytes, namespace,
          hapi_session_id, has_session_row, first_uuid, title, cwd, git_branch, repo,
          harness, account, linked_issue, started_at_ms, last_activity_ms, message_count,
          subagent_count, first_prompt, text, indexed_at_ms)
         VALUES ($cc, $path, $mtime, $size, $ns, $hapi, $hasRow, $firstUuid, $title,
          $cwd, $branch, $repo, $harness, $account, $issue, $started, $last, $count,
          $subagents, $firstPrompt, $text, $now)
         ON CONFLICT(cc_session_id) DO UPDATE SET path = excluded.path,
          mtime_ms = excluded.mtime_ms, size_bytes = excluded.size_bytes,
          namespace = COALESCE(excluded.namespace, transcripts.namespace),
          hapi_session_id = COALESCE(excluded.hapi_session_id, transcripts.hapi_session_id),
          has_session_row = excluded.has_session_row, first_uuid = excluded.first_uuid,
          title = excluded.title, cwd = excluded.cwd, git_branch = excluded.git_branch,
          repo = excluded.repo, harness = excluded.harness,
          account = COALESCE(excluded.account, transcripts.account),
          linked_issue = COALESCE(excluded.linked_issue, transcripts.linked_issue),
          started_at_ms = excluded.started_at_ms,
          last_activity_ms = excluded.last_activity_ms,
          message_count = excluded.message_count, subagent_count = excluded.subagent_count,
          first_prompt = excluded.first_prompt, text = excluded.text,
          indexed_at_ms = excluded.indexed_at_ms`
      )
      .run({
        cc: row.ccSessionId,
        path: row.path,
        mtime: row.mtimeMs,
        size: row.sizeBytes,
        ns: row.namespace,
        hapi: row.hapiSessionId,
        hasRow: row.hasSessionRow ? 1 : 0,
        firstUuid: row.firstUuid,
        title: row.title,
        cwd: row.cwd,
        branch: row.gitBranch,
        repo: row.repo,
        harness: row.harness,
        account: row.account,
        issue: row.linkedIssue,
        started: row.startedAtMs,
        last: row.lastActivityMs,
        count: row.messageCount,
        subagents: row.subagentCount,
        firstPrompt: row.firstPrompt,
        text: row.text,
        now: nowMs,
      });
    this.keyCache?.set(row.ccSessionId, {
      path: row.path,
      mtimeMs: row.mtimeMs,
      sizeBytes: row.sizeBytes,
    });
    if (row.firstUuid) this.relinkChain(row.firstUuid);
  }

  /**
   * Resume-chain linkage. `claude --resume` writes a NEW JSONL (new session id)
   * that replays the prior history with the SAME message uuids, so every file
   * of one conversation shares its first uuid. Ordered by message count then
   * mtime, each member's parent is its predecessor. The session-level fields
   * (Hapimatic id, namespace, linked issue, account) propagate to chain members
   * that lack them, so a pre-resume file of a live session is neither
   * mis-scoped as an orphan nor missing from its issue's filter.
   */
  private relinkChain(firstUuid: string): void {
    const members = this.db
      .prepare(
        `SELECT cc_session_id, namespace, hapi_session_id, linked_issue, account
         FROM transcripts WHERE first_uuid = $u
         ORDER BY message_count ASC, mtime_ms ASC`
      )
      .all({ u: firstUuid }) as Array<{
      cc_session_id: string;
      namespace: string | null;
      hapi_session_id: string | null;
      linked_issue: number | null;
      account: string | null;
    }>;
    const knownNs = members.find(m => m.namespace !== null)?.namespace ?? null;
    const newestFirst = [...members].reverse();
    const knownHapi =
      newestFirst.find(m => m.hapi_session_id)?.hapi_session_id ?? null;
    const knownIssue =
      newestFirst.find(m => m.linked_issue !== null)?.linked_issue ?? null;
    const knownAccount = newestFirst.find(m => m.account)?.account ?? null;
    const update = this.db.prepare(
      `UPDATE transcripts SET parent_cc_session_id = $parent,
         namespace = COALESCE(namespace, $ns),
         hapi_session_id = COALESCE(hapi_session_id, $hapi),
         linked_issue = COALESCE(linked_issue, $issue),
         account = COALESCE(account, $account)
       WHERE cc_session_id = $cc`
    );
    const tx = this.db.transaction(() => {
      members.forEach((m, i) => {
        update.run({
          parent: i === 0 ? null : members[i - 1].cc_session_id,
          ns: knownNs,
          hapi: knownHapi,
          issue: knownIssue,
          account: knownAccount,
          cc: m.cc_session_id,
        });
      });
    });
    tx();
  }

  /** Drop rows whose JSONL no longer exists on disk (the index mirrors disk). */
  deleteMany(ccSessionIds: string[]): void {
    if (ccSessionIds.length === 0) return;
    const del = this.db.prepare(
      "DELETE FROM transcripts WHERE cc_session_id = $cc"
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const cc of ids) del.run({ cc });
    });
    tx(ccSessionIds);
    for (const cc of ccSessionIds) this.keyCache?.delete(cc);
  }

  /** List + search, namespace-scoped (D27). */
  query(
    scope: NamespaceScope,
    q: TranscriptListQuery
  ): { transcripts: TranscriptSummary[]; total: number } {
    const where: string[] = [SCOPE_SQL];
    const params: Record<string, string | number> = {
      ns: scope.namespace,
      owner: scope.isOwner ? 1 : 0,
    };
    if (q.fromMs !== undefined) {
      where.push("t.last_activity_ms >= $from");
      params.from = q.fromMs;
    }
    if (q.toMs !== undefined) {
      where.push("t.started_at_ms <= $to");
      params.to = q.toMs;
    }
    if (q.harness) {
      where.push("t.harness = $harness");
      params.harness = q.harness;
    }
    if (q.account) {
      where.push("t.account = $account");
      params.account = q.account;
    }
    if (q.repo) {
      where.push("t.repo = $repo");
      params.repo = q.repo;
    }
    if (q.linkedIssue !== undefined) {
      where.push("t.linked_issue = $issue");
      params.issue = q.linkedIssue;
    }

    const terms = q.q ? parseSearchTerms(q.q) : [];
    const useFts = terms.length > 0 && this.fts5;
    const useLike = terms.length > 0 && !this.fts5;
    let from = "transcripts t";
    let snippetCol = "NULL AS snippet";
    if (useFts) {
      from =
        "transcripts_fts JOIN transcripts t ON t.rowid = transcripts_fts.rowid";
      where.push("transcripts_fts MATCH $match");
      params.match = toFtsMatch(terms);
      snippetCol = "snippet(transcripts_fts, 0, '[', ']', '…', 16) AS snippet";
    } else if (useLike) {
      terms.forEach((term, i) => {
        where.push(`t.text LIKE $like${i} ESCAPE '\\'`);
        params[`like${i}`] = `%${escapeLike(term)}%`;
      });
    }

    const order =
      q.sort === "oldest"
        ? "t.last_activity_ms ASC"
        : q.sort === "largest"
          ? "t.size_bytes DESC"
          : "t.last_activity_ms DESC";
    const whereSql = where.join(" AND ");
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${whereSql}`)
        .get(params) as { n: number }
    ).n;

    const textCol = useLike ? ", t.text AS text" : "";
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, ${snippetCol}${textCol}
         FROM ${from} WHERE ${whereSql}
         ORDER BY ${order}, t.cc_session_id ASC LIMIT $limit OFFSET $offset`
      )
      .all({ ...params, limit: q.limit, offset: q.offset }) as Array<
      DbRow & { text?: string }
    >;
    const transcripts = rows.map(r =>
      toSummary(
        useLike ? { ...r, snippet: likeSnippet(r.text ?? "", terms) } : r
      )
    );
    return { transcripts, total };
  }

  /** Distinct filter-dropdown values within the caller's scope. */
  filterOptions(scope: NamespaceScope): TranscriptFilterOptions {
    const params = { ns: scope.namespace, owner: scope.isOwner ? 1 : 0 };
    const distinct = <T>(col: string): T[] =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT ${col} AS v FROM transcripts t
             WHERE ${SCOPE_SQL} AND ${col} IS NOT NULL ORDER BY v`
          )
          .all(params) as Array<{ v: T }>
      ).map(r => r.v);
    return {
      harnesses: distinct<string>("t.harness"),
      accounts: distinct<string>("t.account"),
      repos: distinct<string>("t.repo"),
      linkedIssues: distinct<number>("t.linked_issue"),
    };
  }

  /** One row (with its on-disk path) if it is in the caller's scope, else null. */
  getScoped(
    scope: NamespaceScope,
    ccSessionId: string
  ): (TranscriptSummary & { path: string }) | null {
    const row = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, NULL AS snippet FROM transcripts t
         WHERE t.cc_session_id = $cc AND ${SCOPE_SQL}`
      )
      .get({
        cc: ccSessionId,
        ns: scope.namespace,
        owner: scope.isOwner ? 1 : 0,
      }) as DbRow | null;
    if (!row) return null;
    return { ...toSummary(row), path: row.path };
  }

  /**
   * Diagnostic/test seam proving R6 at the storage layer: does ANY stored text
   * (FTS table, text column, first prompt, title) contain `needle`?
   */
  storedTextContains(needle: string): boolean {
    if (this.fts5) {
      const hit = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM transcripts_fts WHERE transcripts_fts MATCH $m"
        )
        .get({ m: toFtsMatch([needle]) }) as { n: number };
      if (hit.n > 0) return true;
    }
    const like = `%${escapeLike(needle)}%`;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM transcripts WHERE text LIKE $l ESCAPE '\\'
         OR first_prompt LIKE $l ESCAPE '\\' OR title LIKE $l ESCAPE '\\'`
      )
      .get({ l: like }) as { n: number };
    return row.n > 0;
  }

  walCheckpoint(): void {
    this.db.run("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.db.close();
  }
}
