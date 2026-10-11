// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionAccountBadge — the Row-1 **Account Badge** of the Session Basic Info Bar
 * (issue #3287 R1, Task 4; epic #3285 correction pass 1). It renders the shared
 * `AccountChip` (E6 `.entity`: colored monogram dot + the account NICKNAME) — the
 * SAME chip the composer's Session Config Cluster shows — and, on tap, opens the
 * Session Configuration modal (E9, operator ruling 2026-09-06: the account
 * selector lives in that modal's Account row, so the badge opens the modal, not
 * a bare account picker). The consumer owns the modal + its open state; this
 * badge only triggers it via `onOpen`.
 *
 * Correction pass 1 (2026-09-05): S2 had shipped this as raw truncated email
 * text pending the E6 mockups; the mockups + taxonomy (#3570) make the entity
 * chip canonical on both surfaces. The label is the operator-set nickname
 * (`useAccountLabel`: nickname → displayName → email local part) cut to the
 * chip's character budget. E9 (operator round 11, 2026-09-06): the chip is a
 * FIXED cell exactly the Loop-Cron slot's width (`LOOP_CRON_SLOT_PX`) with its
 * content CENTERED, so Account Chip over Loop-Cron Chip form one left block —
 * one width, one shared left edge, the nickname centered over the loop counts.
 * A nickname wider than the cell ellipsizes inside it (the cell never grows).
 *
 * Which account (epic #3285 round 15, operator ruling 2026-09-08): the chip
 * always names the LITERAL account — never "default". It reads the shared
 * `useSessionAccountEmail` resolver: the account recorded on the session at
 * spawn, else (a Claude session that recorded none) the node's active account
 * by email. Renders nothing only when there is no account to name: non-Claude
 * sessions (Codex/Gemini) or a node with no active account.
 *
 * The full pointer-event isolation set mirrors the mute bell / queued indicator:
 * the list card's row navigation fires from useLongPress's up-handlers, so every
 * pointer phase must stop here or a tap on the badge would ALSO open the session
 * (a latent sibling of the round-2 #87 bell bug).
 */
import { Button } from "@/components/ui/button";
import { AccountChip } from "@/components/session/AccountChip";
import { useAppContext } from "@/lib/app-context";
import {
  useAccountLabel,
  useAccountMonogram,
} from "@/hooks/queries/useAccountLabels";
import {
  API_KEY_CHIP_IDENTITY,
  useSessionAccountEmail,
  type SessionAccountInput,
} from "@/hooks/queries/useSessionAccountEmail";
import { LOOP_CRON_SLOT_PX } from "@/components/session/rowAnchors";

export function SessionAccountBadge({
  session,
  nodeId,
  onOpen,
}: {
  /** The session (its recorded account + flavor + federation nodeId). */
  session: SessionAccountInput;
  /** Explicit node override (the header knows its node via a prop). */
  nodeId?: string;
  onOpen: () => void;
}) {
  const { api } = useAppContext();
  const {
    email,
    source,
    label: keyLabel,
    keyName,
  } = useSessionAccountEmail(api, session, nodeId);
  const label = useAccountLabel(api, email);
  const monogram = useAccountMonogram(api, email);
  // Issue #4568: an API-key session names its KEY ("Anthropic API · <name>"),
  // never an account — it binds none. Still opens the Session Configuration modal.
  if (source === "api-key" && keyLabel) {
    return (
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        data-testid="session-account-badge"
        data-account-source={source}
        aria-label={`${keyLabel} — billed per token to this API key. Tap to open session configuration`}
        title={`${keyLabel} — billed per token to this API key (real cost) · tap to configure`}
        onClick={e => {
          e.stopPropagation();
          e.preventDefault();
          onOpen();
        }}
        onPointerDown={e => e.stopPropagation()}
        onPointerUp={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        onMouseUp={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        className="shrink-0 justify-center font-normal hover:opacity-80"
        style={{ width: LOOP_CRON_SLOT_PX }}
      >
        <AccountChip
          email={API_KEY_CHIP_IDENTITY}
          label={keyName}
          className="w-full justify-center"
        />
      </Button>
    );
  }
  if (!email) return null;
  const resolvedNote =
    source === "node"
      ? " · resolved from the node's active account (the session recorded none)"
      : "";
  return (
    <Button
      type="button"
      variant="ghostStatic"
      size="bare"
      data-testid="session-account-badge"
      data-account-source={source}
      aria-label={`Account ${label ?? email} (${email}) — tap to switch`}
      title={`${label ?? email} · ${email}${resolvedNote} — tap to switch account`}
      onClick={e => {
        e.stopPropagation();
        e.preventDefault();
        onOpen();
      }}
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
      onMouseDown={e => e.stopPropagation()}
      onMouseUp={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
      onTouchEnd={e => e.stopPropagation()}
      className="shrink-0 justify-center font-normal hover:opacity-80"
      style={{ width: LOOP_CRON_SLOT_PX }}
    >
      <AccountChip
        email={email}
        label={label}
        monogram={monogram}
        className="w-full justify-center"
      />
    </Button>
  );
}
