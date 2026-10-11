// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PermissionModeTrigger (issue #2463) — the shared permission-mode trigger +
 * anchored `PermissionModePicker` popover, deduplicated from the two call sites
 * that wrap the picker:
 *   1. the Composer path — trigger in `ComposerButtons`, popover hosted at
 *      `HappyComposer`'s Root (SPLIT per #2540 ruling D3: the popover lives
 *      OUTSIDE the composer's `overflow-hidden` drop-zone so it isn't clipped),
 *      with the open-state in HappyComposer.
 *   2. `FullscreenPromptEditorModal` — trigger + popover CO-LOCATED, local state.
 *
 * Three exports, ONE module (R2 — trigger + popover-anchoring + open/close state
 * live together):
 *   - `PermissionModeTriggerButton` — the bare tappable label `<button>`.
 *   - `PermissionModePopover` — the `absolute bottom-full …` anchored popover div.
 *   - `PermissionModeTrigger` — the co-located composite that owns its own open
 *     state (wrapper span → button → popover). Drop-in for a call site whose
 *     trigger and popover share a component (Fullscreen).
 *
 * The Composer path CANNOT use the co-located composite (D3 forbids co-locating
 * the popover inside the clip box), so it composes the two controlled sub-exports
 * directly and keeps its open-state in HappyComposer.
 *
 * This module owns NO dismissal logic — `PermissionModePicker` already closes on
 * outside pointer-down + Escape. The trigger `stopPropagation`s pointer-down so
 * the opening tap doesn't re-fire the picker's outside-dismiss handler.
 */
import { useState } from "react";
import type { PermissionMode, PermissionModeOption } from "@hapi/protocol";
import { PermissionModePicker } from "@/components/AssistantChat/PermissionModePicker";

export function PermissionModeTriggerButton(props: {
  label: string;
  open: boolean;
  onToggle?: () => void;
  className: string;
}) {
  return (
    <button /* design-tokens-allow: bare caller-styled composer trigger label - Button box breaks the tight composer row - D2 exception (#3357) */
      type="button"
      onClick={props.onToggle}
      onPointerDown={e => e.stopPropagation()}
      aria-haspopup="menu"
      aria-expanded={props.open}
      className={props.className}
    >
      {props.label}
    </button>
  );
}

export function PermissionModePopover(props: {
  options: PermissionModeOption[];
  current: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute bottom-full left-0 z-50 mb-1">
      <PermissionModePicker
        options={props.options}
        current={props.current}
        onSelect={props.onSelect}
        onClose={props.onClose}
      />
    </div>
  );
}

export function PermissionModeTrigger(props: {
  options: PermissionModeOption[];
  current: PermissionMode;
  label: string;
  onSelect: (mode: PermissionMode) => void;
  wrapperClassName?: string;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className={props.wrapperClassName ?? "relative flex"}>
      <PermissionModeTriggerButton
        label={props.label}
        open={open}
        onToggle={() => setOpen(v => !v)}
        className={props.triggerClassName}
      />
      {open && (
        <PermissionModePopover
          options={props.options}
          current={props.current}
          onSelect={props.onSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
