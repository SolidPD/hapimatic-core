// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #4218 G1 — NEGATIVE-CONTROL typecheck fixture. Never imported, never
 * run: `bun run typecheck` covers it (cli tsconfig `include: src/**\/*.ts`).
 *
 * Every call below passes a raw persisted id or a raw number to a window
 * mutator, and every one is marked `@ts-expect-error`. The file type-checks
 * ONLY because each line errors. If anyone weakens `OwnedWindowTarget` (e.g.
 * to `string | number`), these calls stop erroring and `tsc` fails with TS2578
 * "Unused '@ts-expect-error' directive" — the brand cannot be loosened
 * silently.
 *
 * The type is the only defense against a typo; `ownedTargetGuard.test.ts` is
 * the only defense against a cast — each covers the other's blind spot.
 * Keep each call on ONE line so the directive sits directly above the error.
 */

import type { PersistedSession } from "@/sessionPersistence";
import {
  killWindowWithTree,
  reapDeadPaneWindow,
} from "@/daemon/tmuxSpawnAdapter";
import type { TmuxManager } from "./TmuxManager";

export function g1NegativeControl(
  tmux: TmuxManager,
  session: PersistedSession
): void {
  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.killWindow(session.tmuxWindowId!);
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.killWindow(1);

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.setWindowOption(session.tmuxWindowId!, "k", "v");
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.setWindowOption(1, "k", "v");

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.renameWindow(session.tmuxWindowId!, "n");
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.renameWindow(1, "n");

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.setWindowIdentity(session.tmuxWindowId!, "t");
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.setWindowIdentity(1, "t");

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.sendKeys({ target: session.tmuxWindowId!, keys: "x" });
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.sendKeys({ target: 1, keys: "x" });

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.pipePaneToFile(session.tmuxWindowId!, "/tmp/p");
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.pipePaneToFile(1, "/tmp/p");

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.resizeWindow(session.tmuxWindowId!, 80, 24);
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.resizeWindow(1, 80, 24);

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.respawnPane(session.tmuxWindowId!, "true");
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.respawnPane(1, "true");

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.killWindowByExactName(session.tmuxWindowId!);
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.killWindowByExactName(1);

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void tmux.resetWindowTerminal(session.tmuxWindowId!);
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void tmux.resetWindowTerminal(1);

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void killWindowWithTree(tmux, session.tmuxWindowId!, "tag");
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void killWindowWithTree(tmux, 1, "tag");

  // @ts-expect-error G1: raw persisted id is not an OwnedWindowTarget
  void reapDeadPaneWindow(tmux, session.tmuxWindowId!);
  // @ts-expect-error G1: a raw number is not an OwnedWindowTarget
  void reapDeadPaneWindow(tmux, 1);
}
