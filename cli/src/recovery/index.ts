// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery Module
 *
 * Handles recovery of Claude sessions after Hapimatic restarts.
 */

export { RecoveryService, createRecoveryService } from "./RecoveryService";
export type {
  RecoveryStatus,
  RecoveryResult,
  RecoveryError,
  RecoveryServiceOptions,
} from "./types";
