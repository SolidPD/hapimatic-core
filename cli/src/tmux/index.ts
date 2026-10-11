// SPDX-License-Identifier: AGPL-3.0-only
/**
 * tmux Integration Module
 *
 * Exports for managing Claude sessions via tmux
 */

export { TmuxManager } from "./TmuxManager";
export type {
  TmuxWindow,
  TmuxSession,
  TmuxManagerOptions,
  CreateWindowOptions,
  SendKeysOptions,
} from "./types";
export { TMUX_WINDOW_PREFIX } from "./types";
