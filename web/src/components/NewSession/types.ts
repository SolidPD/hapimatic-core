// SPDX-License-Identifier: AGPL-3.0-only
export type AgentType = "claude" | "codex" | "gemini" | "opencode";
export type SessionType = "simple" | "worktree";
export type ScheduleType = "none" | "at" | "every" | "cron" | "heartbeat";
export type SessionMode = "standard" | "scheduled";
