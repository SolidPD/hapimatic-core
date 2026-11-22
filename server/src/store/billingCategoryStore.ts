// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  BILLING_BUILT_IN_CATEGORY,
  BILLING_CATEGORY_LIMIT,
  BILLING_DEFAULT_CURRENCY,
  BILLING_HISTORY_LIMIT_DEFAULT,
  BILLING_HISTORY_LIMIT_MAX,
  BILLING_LOCAL_SOURCE,
  BILLING_RATE_MINOR_MAX,
  billingCategoryNameKey,
  effectiveCategoryList,
  isBillingCurrency,
  normalizeBillingCategoryName,
  toTrackingCategory,
  type BillingCategoryEventKind,
  type BillingCategoryHistory,
  type BillingCategoryRow,
  type BillingCategorySettingsRow,
  type EffectiveCategoryList,
  type TrackingCategory,
} from "@hapi/protocol";
import { safeJsonParse } from "./json";

// Issue #6779: billing categories and default hourly rates (plan sections 3.1
// to 3.3). Three tables keyed by namespace, created in every gate state and
// written only behind the gate. The SQL holds the keys, NOT NULL, the partial
// unique index and the both-or-neither rate pair; every value domain (the
// name, the rate, every currency) is this writer's (P-5), because a CHECK
// freezes at the first Store open. No foreign keys. Statements are prepared on
// use, never in the constructor (the `billableSwitchStore.ts` precedent), so a
// database whose storage is not ready never stops the server from starting.
//
// Every write runs in an IMMEDIATE transaction (#3631) and every refusal
// THROWS inside it, so the seed and every row the write touched roll back and
// the token stays where it was. No message built here carries a rate.

/** The three tables the readiness check requires. */
export const BILLING_CATEGORY_TABLES = [
  "billing_categories",
  "billing_category_settings",
  "billing_category_events",
] as const;

const TABLE_DDL: Record<(typeof BILLING_CATEGORY_TABLES)[number], string> = {
  billing_categories: `CREATE TABLE IF NOT EXISTS billing_categories (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    default_rate_minor INTEGER,
    default_currency TEXT,
    retired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, id),
    CHECK ((default_rate_minor IS NULL) = (default_currency IS NULL))
  )`,
  billing_category_settings: `CREATE TABLE IF NOT EXISTS billing_category_settings (
    namespace TEXT PRIMARY KEY,
    default_category_id TEXT NOT NULL,
    currency TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  billing_category_events: `CREATE TABLE IF NOT EXISTS billing_category_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    scope TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject_source TEXT,
    subject_id TEXT,
    before_json TEXT,
    after_json TEXT,
    actor_kind TEXT NOT NULL,
    actor_user_agent TEXT,
    entry_node_id TEXT,
    at INTEGER NOT NULL
  )`,
};

const INDEX_DDL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_categories_offered_name
     ON billing_categories(namespace, name COLLATE NOCASE) WHERE retired_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_billing_category_events_ns
     ON billing_category_events(namespace, id)`,
];

/** Each CREATE in its own log-and-continue try (#6646's pattern). */
export function migrateBillingCategoryTables(db: Database): void {
  for (const table of BILLING_CATEGORY_TABLES) {
    try {
      db.exec(TABLE_DDL[table]);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE ${table} (#6779):`,
        error
      );
    }
  }
  for (const ddl of INDEX_DDL) {
    try {
      db.exec(ddl);
    } catch (error) {
      console.error(
        `[Store] Migration failed: ${ddl.split("\n")[0]} (#6779):`,
        error
      );
    }
  }
}

/** True only when all three tables exist (names only, as #6646's check). */
export function hasBillingCategoryStorage(db: Database): boolean {
  try {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`
      )
      .all(...BILLING_CATEGORY_TABLES) as Array<{ name: string }>;
    return rows.length === BILLING_CATEGORY_TABLES.length;
  } catch {
    return false;
  }
}

/** A write's refusal: the route answers `status` with `{ code, ...details }`. */
export class BillingCategoryWriteError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly details: { field?: string; reason?: string; token?: number } = {}
  ) {
    super(`billing category write refused: ${code}`);
    this.name = "BillingCategoryWriteError";
  }
}

export type BillingCategoryWriteContext = {
  namespace: string;
  /** The list token the request read. */
  token: number;
  actor: { kind: "client" | "system"; userAgent: string | null };
  /** This node's ID (writes happen on the owner only). */
  entryNodeId: string | null;
};

/** The effective list with the namespace's token. */
export type BillingCategoryState = EffectiveCategoryList & { token: number };

export type BillingCategoryRateInput = { minor: number; currency: string };

type CategoryDbRow = {
  id: string;
  name: string;
  position: number;
  default_rate_minor: number | null;
  default_currency: string | null;
  retired_at: number | null;
  created_at: number;
  updated_at: number;
};

type SettingsDbRow = {
  default_category_id: string;
  currency: string;
  updated_at: number;
};

type EventDbRow = {
  id: number;
  scope: string;
  kind: string;
  subject_source: string | null;
  subject_id: string | null;
  before_json: string | null;
  after_json: string | null;
  actor_kind: string;
  actor_user_agent: string | null;
  entry_node_id: string | null;
  at: number;
};

type EventInsert = {
  scope: "category" | "settings";
  kind: BillingCategoryEventKind;
  subjectId: string | null;
  before: unknown;
  after: unknown;
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `cat-` and ten characters of [a-z0-9] (the shape of a pin ID), unbiased. */
export function newBillingCategoryId(): string {
  let out = "cat-";
  const bytes = new Uint8Array(32);
  while (out.length < 14) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 252) continue; // 252 = 7 * 36: keep the draw unbiased
      out += ID_ALPHABET[byte % 36];
      if (out.length === 14) break;
    }
  }
  return out;
}

function invalid(field: string, reason: string): BillingCategoryWriteError {
  return new BillingCategoryWriteError(400, "invalid_field", {
    field,
    reason,
  });
}

/** The writer's name domain (3.1): returns the stored form or throws. */
function checkName(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("name", "empty");
  const result = normalizeBillingCategoryName(raw);
  if (!result.ok) throw invalid("name", result.reason);
  return result.name;
}

/** The writer's rate domain (3.1): a safe integer 0..cap and a table code. */
function checkRate(rate: BillingCategoryRateInput | null): void {
  if (rate === null) return;
  if (
    !Number.isSafeInteger(rate.minor) ||
    rate.minor < 0 ||
    rate.minor > BILLING_RATE_MINOR_MAX
  ) {
    throw invalid("defaultRate.minor", "out-of-range");
  }
  if (!isBillingCurrency(rate.currency)) {
    throw invalid("defaultRate.currency", "unknown-currency");
  }
}

function toRow(row: CategoryDbRow): BillingCategoryRow {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    defaultRateMinor: row.default_rate_minor,
    defaultCurrency: row.default_currency,
    retiredAt: row.retired_at,
  };
}

function categorySnapshot(row: CategoryDbRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    position: row.position,
    defaultRateMinor: row.default_rate_minor,
    defaultCurrency: row.default_currency,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function settingsSnapshot(row: SettingsDbRow): Record<string, unknown> {
  return {
    defaultCategoryId: row.default_category_id,
    currency: row.currency,
    updatedAt: row.updated_at,
  };
}

/** One write's view of a namespace: the stored rows, or the seed when none. */
type WorkingState = {
  seeded: boolean;
  settings: SettingsDbRow;
  rows: CategoryDbRow[];
};

export class BillingCategoryStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The namespace's own latest history ID; 0 when it has none (R11). */
  token(namespace: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(id) AS id FROM billing_category_events WHERE namespace = ?"
      )
      .get(namespace) as { id: number | null } | null;
    return row?.id ?? 0;
  }

  private settingsRow(namespace: string): SettingsDbRow | null {
    return (
      (this.db
        .prepare(
          "SELECT default_category_id, currency, updated_at FROM billing_category_settings WHERE namespace = ?"
        )
        .get(namespace) as SettingsDbRow | null) ?? null
    );
  }

  private categoryRows(namespace: string): CategoryDbRow[] {
    return this.db
      .prepare(
        `SELECT id, name, position, default_rate_minor, default_currency, retired_at,
                created_at, updated_at
           FROM billing_categories WHERE namespace = ? ORDER BY position, id`
      )
      .all(namespace) as CategoryDbRow[];
  }

  private effective(
    namespace: string,
    includeRetired: boolean
  ): EffectiveCategoryList {
    const settings = this.settingsRow(namespace);
    const settingsRow: BillingCategorySettingsRow | null = settings
      ? {
          defaultCategoryId: settings.default_category_id,
          currency: settings.currency,
        }
      : null;
    return effectiveCategoryList(
      settingsRow,
      settings ? this.categoryRows(namespace).map(toRow) : [],
      { includeRetired }
    );
  }

  /** The list a namespace reads, never a plain SELECT (3.2). Reads never write. */
  read(
    namespace: string,
    options: { includeRetired?: boolean } = {}
  ): BillingCategoryState {
    const run = this.db.transaction(() => ({
      token: this.token(namespace),
      ...this.effective(namespace, options.includeRetired === true),
    }));
    return run();
  }

  /** The local lookup's read (section 5): through the effective list. */
  getLocal(namespace: string, id: string): TrackingCategory | null {
    const item = this.effective(namespace, true).categories.find(
      category => category.id === id
    );
    return item ? toTrackingCategory(item) : null;
  }

  /** Newest first, at most 100 rows, before an event ID when given. */
  history(
    namespace: string,
    options: { limit?: number; before?: number } = {}
  ): BillingCategoryHistory {
    const limit = Math.min(
      Math.max(1, Math.trunc(options.limit ?? BILLING_HISTORY_LIMIT_DEFAULT)),
      BILLING_HISTORY_LIMIT_MAX
    );
    const before =
      options.before !== undefined && Number.isSafeInteger(options.before)
        ? options.before
        : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        `SELECT id, scope, kind, subject_source, subject_id, before_json, after_json,
                actor_kind, actor_user_agent, entry_node_id, at
           FROM billing_category_events
          WHERE namespace = ? AND id < ?
          ORDER BY id DESC LIMIT ?`
      )
      .all(namespace, before, limit) as EventDbRow[];
    return {
      rows: rows.map(row => ({
        id: row.id,
        scope: row.scope,
        kind: row.kind,
        subjectSource: row.subject_source,
        subjectId: row.subject_id,
        before: row.before_json ? safeJsonParse(row.before_json) : null,
        after: row.after_json ? safeJsonParse(row.after_json) : null,
        actorKind: row.actor_kind,
        actorUserAgent: row.actor_user_agent,
        entryNodeId: row.entry_node_id,
        at: row.at,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]!.id : null,
    };
  }

  add(
    ctx: BillingCategoryWriteContext,
    input: { name: string; defaultRate?: BillingCategoryRateInput | null }
  ): BillingCategoryState {
    const name = checkName(input.name);
    const rate = input.defaultRate ?? null;
    checkRate(rate);
    return this.write(ctx, state => {
      const offered = state.rows.filter(row => row.retired_at === null);
      if (offered.length >= BILLING_CATEGORY_LIMIT) {
        throw new BillingCategoryWriteError(409, "category_limit");
      }
      this.assertNameFree(offered, name, null);
      const at = this.now();
      const row: CategoryDbRow = {
        id: this.freshId(ctx.namespace),
        name,
        position: highestPosition(state.rows) + 1,
        default_rate_minor: rate?.minor ?? null,
        default_currency: rate?.currency ?? null,
        retired_at: null,
        created_at: at,
        updated_at: at,
      };
      return () => {
        this.insertCategory(ctx.namespace, row);
        return [
          {
            scope: "category",
            kind: "added",
            subjectId: row.id,
            before: null,
            after: categorySnapshot(row),
          },
        ];
      };
    });
  }

  update(
    ctx: BillingCategoryWriteContext,
    id: string,
    input: {
      name?: string;
      defaultRate?: BillingCategoryRateInput | null;
      retired?: boolean;
    }
  ): BillingCategoryState {
    const name = input.name === undefined ? undefined : checkName(input.name);
    if (input.defaultRate !== undefined) checkRate(input.defaultRate);
    return this.write(ctx, state => {
      const current = state.rows.find(row => row.id === id);
      if (!current) {
        throw new BillingCategoryWriteError(404, "category_not_found");
      }
      const next: CategoryDbRow = { ...current };
      const changed: BillingCategoryEventKind[] = [];
      if (name !== undefined && name !== current.name) {
        next.name = name;
        changed.push("renamed");
      }
      if (input.defaultRate !== undefined) {
        const minor = input.defaultRate?.minor ?? null;
        const currency = input.defaultRate?.currency ?? null;
        if (
          minor !== current.default_rate_minor ||
          currency !== current.default_currency
        ) {
          next.default_rate_minor = minor;
          next.default_currency = currency;
          changed.push(minor === null ? "rate-cleared" : "rate-set");
        }
      }
      const wasRetired = current.retired_at !== null;
      const restoring = input.retired === false && wasRetired;
      if (input.retired === true && !wasRetired) {
        if (state.settings.default_category_id === id) {
          throw new BillingCategoryWriteError(409, "default_category_retire");
        }
        next.retired_at = this.now();
        changed.push("retired");
      } else if (restoring) {
        const offered = state.rows.filter(row => row.retired_at === null);
        if (offered.length >= BILLING_CATEGORY_LIMIT) {
          throw new BillingCategoryWriteError(409, "category_limit");
        }
        next.retired_at = null;
        next.position = highestPosition(state.rows) + 1;
        changed.push("restored");
      }
      if (changed.length === 0) return null;
      // The name rule on rename and on restore: against the other offered rows.
      if (changed.includes("renamed") || restoring) {
        this.assertNameFree(
          state.rows.filter(row => row.retired_at === null),
          next.name,
          id
        );
      }
      next.updated_at = this.now();
      return () => {
        // One UPDATE, so the partial unique index sees only the row's final
        // state (review S4): a restore that also renames the row away from a
        // name another offered row now holds passes, where restoring first,
        // as its own statement, would break the index.
        this.db
          .prepare(
            `UPDATE billing_categories
                SET name = ?, position = ?, default_rate_minor = ?, default_currency = ?,
                    retired_at = ?, updated_at = ?
              WHERE namespace = ? AND id = ?`
          )
          .run(
            next.name,
            next.position,
            next.default_rate_minor,
            next.default_currency,
            next.retired_at,
            next.updated_at,
            ctx.namespace,
            id
          );
        return [
          {
            scope: "category",
            kind: changed.length === 1 ? changed[0]! : "updated",
            subjectId: id,
            before: categorySnapshot(current),
            after: categorySnapshot(next),
          },
        ];
      };
    });
  }

  reorder(
    ctx: BillingCategoryWriteContext,
    ids: string[]
  ): BillingCategoryState {
    return this.write(ctx, state => {
      const offered = state.rows.filter(row => row.retired_at === null);
      const offeredIds = new Set(offered.map(row => row.id));
      if (
        ids.length !== offered.length ||
        new Set(ids).size !== ids.length ||
        !ids.every(id => offeredIds.has(id))
      ) {
        throw new BillingCategoryWriteError(400, "order_mismatch");
      }
      const beforeOrder = offered.map(row => row.id);
      const unchanged = ids.every(
        (id, index) =>
          beforeOrder[index] === id && offered[index]!.position === index
      );
      if (unchanged) return null;
      const at = this.now();
      return () => {
        const stmt = this.db.prepare(
          "UPDATE billing_categories SET position = ?, updated_at = ? WHERE namespace = ? AND id = ?"
        );
        ids.forEach((id, index) => stmt.run(index, at, ctx.namespace, id));
        return [
          {
            scope: "category",
            kind: "reordered",
            subjectId: null,
            before: beforeOrder,
            after: [...ids],
          },
        ];
      };
    });
  }

  setSettings(
    ctx: BillingCategoryWriteContext,
    input: { defaultCategoryId?: string; currency?: string }
  ): BillingCategoryState {
    if (input.currency !== undefined && !isBillingCurrency(input.currency)) {
      throw invalid("currency", "unknown-currency");
    }
    return this.write(ctx, state => {
      const next: SettingsDbRow = { ...state.settings };
      const changed: BillingCategoryEventKind[] = [];
      if (
        input.defaultCategoryId !== undefined &&
        input.defaultCategoryId !== state.settings.default_category_id
      ) {
        const target = state.rows.find(
          row => row.id === input.defaultCategoryId
        );
        if (!target) {
          throw new BillingCategoryWriteError(404, "category_not_found");
        }
        if (target.retired_at !== null) {
          throw new BillingCategoryWriteError(409, "category_retired");
        }
        next.default_category_id = target.id;
        changed.push("default-set");
      }
      if (
        input.currency !== undefined &&
        input.currency !== state.settings.currency
      ) {
        next.currency = input.currency;
        changed.push("currency-set");
      }
      if (changed.length === 0) return null;
      next.updated_at = this.now();
      return () => {
        this.db
          .prepare(
            `UPDATE billing_category_settings
                SET default_category_id = ?, currency = ?, updated_at = ?
              WHERE namespace = ?`
          )
          .run(
            next.default_category_id,
            next.currency,
            next.updated_at,
            ctx.namespace
          );
        return [
          {
            scope: "settings",
            kind: changed.length === 1 ? changed[0]! : "settings-updated",
            subjectId: null,
            before: settingsSnapshot(state.settings),
            after: settingsSnapshot(next),
          },
        ];
      };
    });
  }

  /**
   * One write (3.3): the token check; the working state (the seed when the
   * namespace has no settings row); `plan` refuses by throwing, returns null
   * when nothing changes, or returns the apply step. Only a change seeds.
   */
  private write(
    ctx: BillingCategoryWriteContext,
    plan: (state: WorkingState) => (() => EventInsert[]) | null
  ): BillingCategoryState {
    const run = this.db.transaction((): BillingCategoryState => {
      const token = this.token(ctx.namespace);
      if (ctx.token !== token) {
        throw new BillingCategoryWriteError(409, "stale_token", { token });
      }
      const state = this.workingState(ctx.namespace);
      const apply = plan(state);
      if (apply === null) {
        return { token, ...this.effective(ctx.namespace, false) };
      }
      if (state.seeded) this.materialiseSeed(ctx, state);
      for (const event of apply()) this.insertEvent(ctx, event);
      return {
        token: this.token(ctx.namespace),
        ...this.effective(ctx.namespace, false),
      };
    });
    return run.immediate();
  }

  private workingState(namespace: string): WorkingState {
    const settings = this.settingsRow(namespace);
    if (settings) {
      return { seeded: false, settings, rows: this.categoryRows(namespace) };
    }
    const at = this.now();
    return {
      seeded: true,
      settings: {
        default_category_id: BILLING_BUILT_IN_CATEGORY.id,
        currency: BILLING_DEFAULT_CURRENCY,
        updated_at: at,
      },
      rows: [
        {
          id: BILLING_BUILT_IN_CATEGORY.id,
          name: BILLING_BUILT_IN_CATEGORY.name,
          position: 0,
          default_rate_minor: null,
          default_currency: null,
          retired_at: null,
          created_at: at,
          updated_at: at,
        },
      ],
    };
  }

  /** The first write's seed: the built-in row, the settings row, `seeded`. */
  private materialiseSeed(
    ctx: BillingCategoryWriteContext,
    state: WorkingState
  ): void {
    const builtIn = state.rows.find(
      row => row.id === BILLING_BUILT_IN_CATEGORY.id
    )!;
    this.insertCategory(ctx.namespace, builtIn);
    this.db
      .prepare(
        `INSERT INTO billing_category_settings (namespace, default_category_id, currency, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        ctx.namespace,
        state.settings.default_category_id,
        state.settings.currency,
        state.settings.updated_at
      );
    this.insertEvent(
      { ...ctx, actor: { kind: "system", userAgent: null } },
      {
        scope: "category",
        kind: "seeded",
        subjectId: builtIn.id,
        before: null,
        after: categorySnapshot(builtIn),
      }
    );
  }

  private insertCategory(namespace: string, row: CategoryDbRow): void {
    this.db
      .prepare(
        `INSERT INTO billing_categories (namespace, id, name, position, default_rate_minor,
            default_currency, retired_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        namespace,
        row.id,
        row.name,
        row.position,
        row.default_rate_minor,
        row.default_currency,
        row.retired_at,
        row.created_at,
        row.updated_at
      );
  }

  private insertEvent(
    ctx: BillingCategoryWriteContext,
    event: EventInsert
  ): void {
    this.db
      .prepare(
        `INSERT INTO billing_category_events (namespace, scope, kind, subject_source, subject_id,
            before_json, after_json, actor_kind, actor_user_agent, entry_node_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ctx.namespace,
        event.scope,
        event.kind,
        event.subjectId === null ? null : BILLING_LOCAL_SOURCE,
        event.subjectId,
        event.before === null ? null : JSON.stringify(event.before),
        event.after === null ? null : JSON.stringify(event.after),
        ctx.actor.kind,
        ctx.actor.userAgent,
        ctx.entryNodeId,
        this.now()
      );
  }

  /** 409 `name_taken` when another offered row has the same name key (3.1). */
  private assertNameFree(
    offered: CategoryDbRow[],
    name: string,
    selfId: string | null
  ): void {
    const key = billingCategoryNameKey(name);
    if (
      offered.some(
        row => row.id !== selfId && billingCategoryNameKey(row.name) === key
      )
    ) {
      throw new BillingCategoryWriteError(409, "name_taken");
    }
  }

  private freshId(namespace: string): string {
    const exists = this.db.prepare(
      "SELECT 1 FROM billing_categories WHERE namespace = ? AND id = ?"
    );
    for (;;) {
      const id = newBillingCategoryId();
      if (!exists.get(namespace, id)) return id;
    }
  }
}

function highestPosition(rows: readonly CategoryDbRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.position), -1);
}
