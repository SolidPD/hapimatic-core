// SPDX-License-Identifier: AGPL-3.0-only
/**
 * PermissionModePicker (issue #2455) — the reusable permission-mode popover,
 * extracted from HappyComposer's old gear "Settings" overlay. Rendered by the
 * three in-session surfaces that expose the permission control: StatusBar (the
 * tappable permission label), the fullscreen prompt editor, and — historically —
 * the composer gear (now removed).
 *
 * Design (KD-5): a `FloatingOverlay` popover (the "existing composer-overlay
 * style" the issue names), width-fit to its widest row via `w-max` (NOT the old
 * `w-full` stretch), with a per-mode ⓘ affordance (the shared touch-friendly
 * `Tooltip`) revealing a plain-language explanation — `title` alone is unreliable
 * on iOS (OR-2).
 *
 * The caller owns anchoring/positioning (it renders this inside an
 * absolutely-positioned container next to its trigger). This component owns
 * dismissal: it closes on outside pointer-down and on Escape. To avoid the
 * "reopen race", a caller's trigger should `stopPropagation` on pointer-down so
 * this component's outside handler doesn't fire for the trigger tap itself.
 */
import { useEffect, useRef } from "react";
import type { PermissionMode, PermissionModeOption } from "@hapi/protocol";
import { FloatingOverlay } from "@/components/ChatInput/FloatingOverlay";
import { Tooltip } from "@/components/NewSession/FormField";

/**
 * Plain-language explanation per permission mode, revealed behind the ⓘ. Keyed
 * by every `PermissionMode` so the map is exhaustive across flavors (claude:
 * default/acceptEdits/plan/bypassPermissions; codex: read-only/safe-yolo/yolo).
 */
const PERMISSION_MODE_EXPLANATIONS: Record<PermissionMode, string> = {
  default: "Claude asks for approval before editing files or running commands.",
  acceptEdits:
    "File edits are auto-approved; Claude still asks before running commands.",
  plan: "Plan mode — Claude proposes a plan and makes no changes.",
  bypassPermissions:
    "Full YOLO — Claude edits files and runs commands without asking. Use with care.",
  "read-only":
    "Claude can read and inspect, but cannot modify or run anything.",
  "safe-yolo":
    "Auto-runs low-risk actions; still blocks dangerous or destructive ones.",
  yolo: "Full YOLO — Claude edits files and runs commands without asking. Use with care.",
};

export function PermissionModePicker(props: {
  options: PermissionModeOption[];
  current: PermissionMode;
  disabled?: boolean;
  onSelect: (mode: PermissionMode) => void;
  onClose: () => void;
}) {
  const { options, current, disabled, onSelect, onClose } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside pointer-down + Escape. The ⓘ tooltip trigger lives inside
  // rootRef so tapping it never closes the picker; its portal-rendered bubble
  // does escape rootRef, but tapping the explanation text to dismiss is benign.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} className="w-max">
      <FloatingOverlay maxHeight={320}>
        <div className="py-1" role="menu" aria-label="Permission mode">
          {options.map(option => {
            const isCurrent = option.mode === current;
            return (
              <div
                key={option.mode}
                className={`flex items-center gap-2 px-3 py-2 ${
                  disabled ? "opacity-50" : ""
                }`}
              >
                <button /* design-tokens-allow: full-width left-aligned menu radio row (disabled + onMouseDown focus-guard) - D2 E3 exception (#3357) */
                  type="button"
                  disabled={disabled}
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  onClick={() => {
                    if (disabled) return;
                    onSelect(option.mode);
                    onClose();
                  }}
                  onMouseDown={e => e.preventDefault()}
                  className={`flex flex-1 items-center gap-2 text-left text-sm transition-colors ${
                    disabled ? "cursor-not-allowed" : "cursor-pointer"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                      isCurrent
                        ? "border-[var(--app-link)]"
                        : "border-[var(--app-hint)]"
                    }`}
                  >
                    {isCurrent && (
                      <span className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                    )}
                  </span>
                  <span
                    className={`whitespace-nowrap ${
                      isCurrent ? "text-[var(--app-link)]" : ""
                    }`}
                  >
                    {option.label}
                  </span>
                </button>
                <Tooltip text={PERMISSION_MODE_EXPLANATIONS[option.mode]} />
              </div>
            );
          })}
        </div>
      </FloatingOverlay>
    </div>
  );
}
