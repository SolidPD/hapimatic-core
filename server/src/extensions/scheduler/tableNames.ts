// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Physical table names for `builtin.scheduler` (issue #1274).
 *
 * Single source of truth shared by the migration (which renames/creates the
 * tables) and the query layer (which reads and writes them). They MUST agree —
 * if the migration renames to one name while the queries address another, the
 * scheduler starts cleanly and then fails at first query with
 * `SQLiteError: no such table`, which is a runtime failure that no amount of
 * migration-only unit testing will surface.
 *
 * The `ext_<sanitizedId>_` prefix matches the convention the extension host
 * applies in `host.store.addTable` for `builtin.scheduler`.
 */

/** Scheduled task definitions (formerly the core-owned `scheduled_tasks`). */
export const SCHEDULER_TASKS_TABLE = "ext_builtin_scheduler_tasks";

/** Per-run execution history (formerly the core-owned `task_executions`). */
export const SCHEDULER_EXECS_TABLE = "ext_builtin_scheduler_task_executions";
