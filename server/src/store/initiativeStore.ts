// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { newUuidV7 } from "./turns/ids";
import type {
  InitiativePhase,
  StoredInitiative,
  StoredInitiativeEvent,
  StoredInitiativeRosterEntry,
} from "./types";

/** Fields accepted when creating an initiative. Roster + events are never client-set. */
export interface CreateInitiativeInput {
  scopeRef: string;
  /** Defaults to `"planning"`. */
  phase?: InitiativePhase;
  /** `null` = uncapped. */
  tokenBudget?: number | null;
  tokensSpent?: number;
}

/** Filter for {@link InitiativeStore.list}. Omitted fields mean "any". */
export interface ListInitiativesFilter {
  scopeRef?: string;
  phase?: InitiativePhase;
}

interface InitiativeRow {
  id: string;
  scope_ref: string;
  phase: string;
  token_budget: number | null;
  tokens_spent: number;
  created_at_ms: number;
  updated_at_ms: number | null;
  reconciled_at_ms: number | null;
}

interface RosterRow {
  session_id: string;
  attached_at_ms: number;
  detached_at_ms: number | null;
}

interface EventRow {
  id: string;
  initiative_id: string;
  kind: string;
  payload: string | null;
  created_at_ms: number;
}

function toRosterEntry(row: RosterRow): StoredInitiativeRosterEntry {
  return {
    sessionId: row.session_id,
    attachedAtMs: row.attached_at_ms,
    detachedAtMs: row.detached_at_ms,
  };
}

function toStoredEvent(row: EventRow): StoredInitiativeEvent {
  return {
    id: row.id,
    initiativeId: row.initiative_id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    createdAtMs: row.created_at_ms,
  };
}

function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Written by this store via JSON.stringify — a parse failure is a corrupt
    // row, not a normal path. Degrade to null rather than throw on read.
    return null;
  }
}

/**
 * SQLite-backed store for the first-class initiative object (skill-revamp 3.1,
 * issue #2156, epic rp1-home#1319).
 *
 * An initiative caches a GitHub work scope's PM world-state — its `scopeRef`,
 * session roster, token budget, current phase, and an append-only event log — so
 * a PM tick reads it in one call instead of reconstructing from labels +
 * transcripts. It is a CACHE over GitHub label truth (reconcile-on-read; GitHub
 * wins on conflict), never authoritative — `reconciledAtMs` + {@link
 * InitiativeStore.isStale} make staleness detectable.
 *
 * Methods are SYNCHRONOUS and MAY THROW (constraint violations, locked DB); the
 * ROUTE layer owns fail-open (route-level try/catch), matching the low-volume,
 * off-request-path `pm_spawn_roster` precedent. The three tables
 * (`initiatives` / `initiative_roster` / `initiative_events`) are created in
 * `Store.runMigrations()` (`store/index.ts`), NOT here (parity with the other
 * store-direct entities).
 *
 * Every id — the initiative AND each event — is a UUIDv7 (`newUuidV7()`):
 * time-ordered and coordination-free across federation nodes, so a future
 * cross-node union is a pure concat, and #2157's `id > cursor` event drain gets
 * a monotonic cursor for free.
 *
 * The append-only invariant (R4) is enforced by ABSENCE: there is no
 * `updateEvent` / `deleteEvent` method. `appendEvent` is the ONLY event writer;
 * every mutating method routes its event through it inside the SAME transaction,
 * so a roster/phase/budget change and its event commit atomically or not at all.
 */
export class InitiativeStore {
  constructor(
    private readonly db: Database,
    /** Injectable clock for deterministic tests (mirrors PmRosterStore). */
    private readonly getNow: () => number = Date.now
  ) {}

  /**
   * R1: persist a new initiative (all five conceptual fields) and return it with
   * a server-minted UUIDv7 id. Appends an `initiative_created` event in the SAME
   * transaction.
   */
  create(input: CreateInitiativeInput): StoredInitiative {
    const id = newUuidV7();
    const now = this.getNow();
    const phase: InitiativePhase = input.phase ?? "planning";
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO initiatives (
             id, scope_ref, phase, token_budget, tokens_spent,
             created_at_ms, updated_at_ms, reconciled_at_ms
           ) VALUES (
             @id, @scope_ref, @phase, @token_budget, @tokens_spent,
             @created_at_ms, @updated_at_ms, @reconciled_at_ms
           )`
        )
        .run({
          id,
          scope_ref: input.scopeRef,
          phase,
          token_budget: input.tokenBudget ?? null,
          tokens_spent: input.tokensSpent ?? 0,
          created_at_ms: now,
          updated_at_ms: null,
          reconciled_at_ms: null,
        });
      this.appendEvent(id, "initiative_created", { scopeRef: input.scopeRef });
    });
    apply();
    const created = this.get(id);
    if (!created) {
      throw new Error(
        `initiative create succeeded but row not found for ${id}`
      );
    }
    return created;
  }

  /** Fetch one initiative with its roster embedded, or `null`. */
  get(id: string): StoredInitiative | null {
    const row = this.db
      .prepare("SELECT * FROM initiatives WHERE id = @id")
      .get({ id }) as InitiativeRow | null;
    if (!row) return null;
    return {
      id: row.id,
      scopeRef: row.scope_ref,
      phase: row.phase as InitiativePhase,
      tokenBudget: row.token_budget,
      tokensSpent: row.tokens_spent,
      roster: this.getRoster(id),
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      reconciledAtMs: row.reconciled_at_ms,
    };
  }

  /**
   * The initiative's roster rows (attached AND detached), oldest-attach first.
   * Backs Task 8's one-call read (R3) and any consumer that wants membership
   * without the full initiative.
   */
  getRoster(id: string): StoredInitiativeRosterEntry[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, attached_at_ms, detached_at_ms
           FROM initiative_roster
          WHERE initiative_id = @id
          ORDER BY attached_at_ms ASC`
      )
      .all({ id }) as RosterRow[];
    return rows.map(toRosterEntry);
  }

  /** List initiatives (each with roster embedded), newest-created first. */
  list(filter: ListInitiativesFilter = {}): StoredInitiative[] {
    const where: string[] = [];
    const args: Record<string, string> = {};
    if (filter.scopeRef !== undefined) {
      where.push("scope_ref = @scope_ref");
      args.scope_ref = filter.scopeRef;
    }
    if (filter.phase !== undefined) {
      where.push("phase = @phase");
      args.phase = filter.phase;
    }
    const rows = this.db
      .prepare(
        `SELECT id FROM initiatives
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at_ms DESC, id DESC`
      )
      .all(args) as Array<{ id: string }>;
    // Low-volume entity (a handful of live initiatives) — a per-row roster read
    // is acceptable and keeps get()/list() sharing one roster path.
    return rows
      .map(r => this.get(r.id))
      .filter((i): i is StoredInitiative => i !== null);
  }

  /**
   * Transactional 3-table delete (events, roster, initiative row) in ONE
   * transaction — there are no FKs by design, so no cascade exists. Returns
   * `true` when the initiative existed, `false` when there was nothing to delete.
   */
  delete(id: string): boolean {
    let existed = false;
    const apply = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM initiative_events WHERE initiative_id = @id")
        .run({ id });
      this.db
        .prepare("DELETE FROM initiative_roster WHERE initiative_id = @id")
        .run({ id });
      const res = this.db
        .prepare("DELETE FROM initiatives WHERE id = @id")
        .run({ id });
      existed = res.changes > 0;
    });
    apply();
    return existed;
  }

  /**
   * R2: attach a session to the roster AND append a `session_attached` event in
   * the SAME transaction. Upserts on the `(initiative_id, session_id)` PK so
   * attach-after-detach re-attaches (clears `detached_at_ms`, refreshes
   * `attached_at_ms`) instead of throwing on the PK — one row per (initiative,
   * session) pair; multiple attach cycles live in the event log, not the roster.
   */
  attachSession(id: string, sessionId: string): void {
    const now = this.getNow();
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO initiative_roster
             (initiative_id, session_id, attached_at_ms, detached_at_ms)
           VALUES (@id, @session_id, @now, NULL)
           ON CONFLICT(initiative_id, session_id) DO UPDATE SET
             attached_at_ms = excluded.attached_at_ms,
             detached_at_ms = NULL`
        )
        .run({ id, session_id: sessionId, now });
      this.touch(id, now);
      this.appendEvent(id, "session_attached", { sessionId }, now);
    });
    apply();
  }

  /**
   * R2: detach a session (set `detached_at_ms`) AND append a `session_detached`
   * event in the SAME transaction.
   */
  detachSession(id: string, sessionId: string): void {
    const now = this.getNow();
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE initiative_roster
              SET detached_at_ms = @now
            WHERE initiative_id = @id
              AND session_id = @session_id
              AND detached_at_ms IS NULL`
        )
        .run({ id, session_id: sessionId, now });
      this.touch(id, now);
      this.appendEvent(id, "session_detached", { sessionId }, now);
    });
    apply();
  }

  /**
   * R6: transition phase AND append a `phase_changed` event carrying `{from, to}`
   * — the signal #2157's queue consumes. No-op (no UPDATE, no event) when the
   * phase is unchanged. Throws if the initiative does not exist (the route gates
   * on existence first, so this is a genuine anomaly).
   */
  setPhase(id: string, phase: InitiativePhase): void {
    const row = this.db
      .prepare("SELECT phase FROM initiatives WHERE id = @id")
      .get({ id }) as { phase: string } | null;
    if (!row) throw new Error(`setPhase: no initiative ${id}`);
    const from = row.phase as InitiativePhase;
    if (from === phase) return; // no-op: same phase, no event
    const now = this.getNow();
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE initiatives SET phase = @phase, updated_at_ms = @now WHERE id = @id"
        )
        .run({ id, phase, now });
      this.appendEvent(id, "phase_changed", { from, to: phase }, now);
    });
    apply();
  }

  /**
   * Update the budget fields AND append a `budget_updated` event in the SAME
   * transaction. `tokensSpent` is optional (leave the running total untouched
   * when only the cap changes).
   */
  setBudget(
    id: string,
    tokenBudget: number | null,
    tokensSpent?: number
  ): void {
    const now = this.getNow();
    const apply = this.db.transaction(() => {
      if (tokensSpent === undefined) {
        this.db
          .prepare(
            "UPDATE initiatives SET token_budget = @token_budget, updated_at_ms = @now WHERE id = @id"
          )
          .run({ id, token_budget: tokenBudget, now });
      } else {
        this.db
          .prepare(
            `UPDATE initiatives
                SET token_budget = @token_budget,
                    tokens_spent = @tokens_spent,
                    updated_at_ms = @now
              WHERE id = @id`
          )
          .run({
            id,
            token_budget: tokenBudget,
            tokens_spent: tokensSpent,
            now,
          });
      }
      this.appendEvent(id, "budget_updated", { tokenBudget, tokensSpent }, now);
    });
    apply();
  }

  /**
   * R5: mark the initiative reconciled against GitHub truth (set
   * `reconciled_at_ms = now`) AND append a `reconciled` event. This is the
   * "cache re-verified" stamp {@link InitiativeStore.isStale} reads.
   */
  markReconciled(id: string): void {
    const now = this.getNow();
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE initiatives SET reconciled_at_ms = @now, updated_at_ms = @now WHERE id = @id"
        )
        .run({ id, now });
      this.appendEvent(id, "reconciled", {}, now);
    });
    apply();
  }

  /**
   * The ONLY event writer. Mints a UUIDv7 event id (time-ordered — #2157's
   * `id > cursor` drain depends on it) and inserts one row. `kind` is typed
   * `string` (house rule K1: the DB column is unconstrained; #2157/#2158 append
   * SUPERSET kinds; zod gates the canonical set at the route edge). Does NOT open
   * its own transaction, so it composes inside the mutating methods' transactions.
   */
  appendEvent(
    id: string,
    kind: string,
    payload?: Record<string, unknown> | null,
    now: number = this.getNow()
  ): StoredInitiativeEvent {
    const eventId = newUuidV7();
    const payloadJson =
      payload == null || Object.keys(payload).length === 0
        ? null
        : JSON.stringify(payload);
    this.db
      .prepare(
        `INSERT INTO initiative_events (id, initiative_id, kind, payload, created_at_ms)
         VALUES (@id, @initiative_id, @kind, @payload, @created_at_ms)`
      )
      .run({
        id: eventId,
        initiative_id: id,
        kind,
        payload: payloadJson,
        created_at_ms: now,
      });
    return {
      id: eventId,
      initiativeId: id,
      kind,
      payload: payloadJson ? (payload ?? null) : null,
      createdAtMs: now,
    };
  }

  /**
   * The N most recent events for an initiative, newest first. Backed by
   * `idx_initiative_events_initiative(initiative_id, created_at_ms DESC)`; the
   * secondary `id DESC` breaks same-millisecond ties deterministically (UUIDv7
   * ids are time-ordered).
   */
  recentEvents(id: string, limit = 50): StoredInitiativeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM initiative_events
          WHERE initiative_id = @id
          ORDER BY created_at_ms DESC, id DESC
          LIMIT @limit`
      )
      .all({ id, limit }) as EventRow[];
    return rows.map(toStoredEvent);
  }

  /**
   * R5: is this initiative's cache stale? True when it was never reconciled, or
   * when its last reconciliation is older than the caller-supplied bound. Pure
   * over the row + bound + the injected clock, so the route and any future PM
   * consumer share one definition.
   */
  isStale(initiative: StoredInitiative, staleAfterMs: number): boolean {
    if (initiative.reconciledAtMs == null) return true;
    return this.getNow() - initiative.reconciledAtMs > staleAfterMs;
  }

  // ── Skill-revamp 3.2 (#2157): event-driven PM queue ────────────────────
  //
  // The push half — the webhook receiver + peer-session observer append via
  // `appendEvent` / `recordWebhookEvent`; the PM tick drains via `drain`. The
  // event log is #2156's `initiative_events`; the two webhook_* tables are
  // #2157's (migrated in `store/index.ts`).

  /**
   * R5: drain the event log for a PM tick. Returns events STRICTLY newer than
   * `sinceEventId` (the client-held cursor), oldest-first, capped at `limit`.
   *
   * 🔴 The cursor is on `id` ONLY — `WHERE id > ? ORDER BY id ASC` — NEVER mixed
   * with `created_at_ms` (which is non-total: two same-millisecond events tie,
   * so a `created_at_ms` cursor could skip or repeat an event). This is valid AND
   * indexed because #2156 mandates UUIDv7 EVENT ids (time-ordered — `id > cursor`
   * is a correct monotonic cursor) AND adds `idx_initiative_events_cursor
   * (initiative_id, id)`. An empty/undefined cursor drains from the beginning
   * (every UUIDv7 id sorts after `""`).
   *
   * `nextCursor` is the id to pass as `sinceEventId` next time — the last drained
   * event's id, or the unchanged prior cursor (`null` if there was none) when the
   * drain is empty (R5's cheap no-op tick).
   */
  drain(
    initiativeId: string,
    sinceEventId: string | undefined,
    limit: number
  ): { events: StoredInitiativeEvent[]; nextCursor: string | null } {
    const cursor = sinceEventId ?? "";
    const rows = this.db
      .prepare(
        `SELECT * FROM initiative_events
          WHERE initiative_id = @id AND id > @cursor
          ORDER BY id ASC
          LIMIT @limit`
      )
      .all({ id: initiativeId, cursor, limit }) as EventRow[];
    const events = rows.map(toStoredEvent);
    const nextCursor =
      events.length > 0 ? events[events.length - 1].id : (sinceEventId ?? null);
    return { events, nextCursor };
  }

  /**
   * Resolve the initiative a webhook targets, from `repository.full_name` +
   * issue number. Returns `null` when nothing matches (→ the receiver answers
   * `202 ignored`, not an error).
   *
   * `epic:` scheme — scope_ref is `epic:owner/repo#N`. A webhook for ANY issue/PR
   * in `owner/repo` maps to the epic-initiative for that repo (the initiative
   * caches the whole epic's scope), so match on the `owner/repo` segment and
   * ignore `#N`. `milestone:` / `project:` scopes have no repo-unique prefix (a
   * project can span repos), so fall back to roster → session → linked-issue: an
   * initiative whose ACTIVE roster holds a session linked to exactly this
   * `(repo, issueNumber)`.
   */
  resolveByRepoIssue(repoFullName: string, issueNumber: number): string | null {
    const epicRows = this.db
      .prepare(
        "SELECT id, scope_ref FROM initiatives WHERE scope_ref LIKE 'epic:%'"
      )
      .all() as Array<{ id: string; scope_ref: string }>;
    for (const row of epicRows) {
      const rest = row.scope_ref.slice("epic:".length);
      const repo = rest.split("#")[0];
      if (repo === repoFullName) return row.id;
    }
    // Roster fallback for milestone:/project: scopes. Joins to `sessions` (whose
    // `linked_issue` is JSON `{repo, number, ...}`) — best-effort; returns null
    // when no rostered session is linked to this exact (repo, issue).
    const rosterRow = this.db
      .prepare(
        "SELECT ir.initiative_id AS id FROM initiative_roster ir " +
          "JOIN sessions s ON s.id = ir.session_id " +
          "WHERE ir.detached_at_ms IS NULL " +
          "AND json_extract(s.linked_issue, '$.repo') = @repo " +
          "AND json_extract(s.linked_issue, '$.number') = @num " +
          "LIMIT 1"
      )
      .get({ repo: repoFullName, num: issueNumber }) as
      | { id: string }
      | undefined;
    return rosterRow?.id ?? null;
  }

  /**
   * R4: the ids of every initiative whose ACTIVE roster (detached_at_ms IS NULL)
   * contains `sessionId`. The peer-session observer appends a session event to
   * each of these. A session on no roster → `[]` (do not synthesize initiatives).
   */
  initiativesForSession(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT initiative_id FROM initiative_roster " +
          "WHERE session_id = @sid AND detached_at_ms IS NULL"
      )
      .all({ sid: sessionId }) as Array<{ initiative_id: string }>;
    return rows.map(r => r.initiative_id);
  }

  /**
   * R3: has this `X-GitHub-Delivery` id already been recorded? The cheap
   * pre-check (webhook receiver step 4) before parsing the body. The AUTHORITATIVE
   * exactly-once guard is the PK INSERT inside {@link recordWebhookEvent} — this
   * only avoids the parse+resolve work for an already-seen delivery.
   */
  isDeliverySeen(deliveryId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = @id"
      )
      .get({ id: deliveryId }) as { delivery_id: string } | null;
    // bun:sqlite's `.get()` returns `null` (NOT `undefined`) for no row — check
    // `!= null` so a miss isn't mistaken for a hit (the `!== undefined` trap).
    return row != null;
  }

  /** R6: the last verified webhook-delivery timestamp for a repo, or `null`. */
  getWebhookLastDeliveryMs(repo: string): number | null {
    const row = this.db
      .prepare(
        "SELECT last_delivery_at_ms FROM webhook_health WHERE repo = @repo"
      )
      .get({ repo }) as { last_delivery_at_ms: number } | undefined;
    return row?.last_delivery_at_ms ?? null;
  }

  /**
   * R3 + R6 atomicity: record ONE verified webhook delivery in a SINGLE
   * transaction — the delivery-dedup INSERT, the `appendEvent`, and the
   * `webhook_health` stamp commit together or not at all. A dedup row committed
   * WITHOUT its event would turn GitHub's redelivery into a permanent no-op and
   * lose the event; the reverse split would duplicate it. Both are impossible
   * because all three writes share one `db.transaction`.
   *
   * Returns `{appended, duplicate}`. `duplicate: true` (with `appended: null`)
   * means a concurrent redelivery raced past the step-4 pre-check and the PK
   * already existed — the receiver answers `2xx` and appends nothing.
   */
  recordWebhookEvent(params: {
    deliveryId: string;
    event: string;
    repo: string;
    initiativeId: string;
    kind: string;
    payload?: Record<string, unknown> | null;
    now?: number;
    /**
     * TEST-ONLY fault-injection seam (mirrors the injectable-clock precedent).
     * Invoked INSIDE the transaction, AFTER the delivery-dedup INSERT and BEFORE
     * `appendEvent`. A throw here MUST roll the delivery INSERT back (R3 crash-
     * window atomicity — see Task 5 case (h)). Production callers omit it.
     */
    beforeAppend?: () => void;
  }): { appended: StoredInitiativeEvent | null; duplicate: boolean } {
    const now = params.now ?? this.getNow();

    // Dedup pre-check. The store is synchronous single-threaded, so the check +
    // the INSERT below are effectively atomic (no await between them) — a
    // concurrent redelivery cannot interleave.
    if (this.isDeliverySeen(params.deliveryId)) {
      return { appended: null, duplicate: true };
    }

    // Explicit BEGIN/COMMIT/ROLLBACK (the proven #1122 migration pattern) rather
    // than `db.transaction(...)` — the dedup INSERT, appendEvent, and health
    // stamp MUST commit together or roll back together, and this makes the
    // rollback-on-throw explicit (R3/R6 crash-window atomicity). Distinct bind
    // names (`@received`/`@ts`/`@cutoff`) avoid any named-param ambiguity.
    let appended: StoredInitiativeEvent | null = null;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO webhook_deliveries (delivery_id, event, received_at_ms) " +
            "VALUES (@id, @event, @received)"
        )
        .run({
          id: params.deliveryId,
          event: params.event,
          received: now,
        });
      params.beforeAppend?.();
      appended = this.appendEvent(
        params.initiativeId,
        params.kind,
        params.payload,
        now
      );
      this.db
        .prepare(
          "INSERT INTO webhook_health (repo, last_delivery_at_ms) " +
            "VALUES (@repo, @ts) " +
            "ON CONFLICT(repo) DO UPDATE SET " +
            "last_delivery_at_ms = excluded.last_delivery_at_ms"
        )
        .run({ repo: params.repo, ts: now });
      // Prune the dedup table to 7 days on insert — cheap, keeps it bounded.
      this.db
        .prepare(
          "DELETE FROM webhook_deliveries WHERE received_at_ms < @cutoff"
        )
        .run({ cutoff: now - 7 * 24 * 60 * 60 * 1000 });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { appended, duplicate: false };
  }

  /** Bump `updated_at_ms` — the "something about this initiative changed" stamp. */
  private touch(id: string, now: number): void {
    this.db
      .prepare("UPDATE initiatives SET updated_at_ms = @now WHERE id = @id")
      .run({ id, now });
  }
}
