// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Same-session context reset at a stage boundary (issue #6559, epic #6163).
 * Design: docs/internal/architecture/context-reset.md.
 */

export {
  RATE_LIMIT_GRACE_MS,
  checkArm,
  decideFire,
  hasPendingChallenge,
  type ArmDecision,
  type ArmFacts,
  type FireDecision,
  type FireFacts,
} from "./policy";
export {
  LANE_CHECKPOINT_PATH,
  extractInstructingMessages,
  renderResumeMessage,
  selectCarriedMessages,
  type CarriedMessage,
  type RenderInput,
  type RenderRow,
  type StoredMessageLike,
} from "./render";
export {
  CONTEXT_RESET_REPORT_VERSION,
  buildReport,
  checkStreak,
  readContextResetEvents,
  renderMarkdown,
  type ContextResetEventRow,
  type ContextResetReport,
  type StreakResult,
} from "./report";
export {
  ContextResetService,
  challengePendingOnDisk,
  isLockLabel,
  readChallengeInput,
  readLocks,
  type ContextResetEngine,
  type ContextResetEvent,
  type ContextResetLabelEvent,
  type ContextResetPublicRow,
  type ContextResetRequests,
  type ContextResetSendPayload,
  type ContextResetSendResult,
  type ContextResetServiceConfig,
  type ContextResetServiceOptions,
  type LockRead,
} from "./service";
