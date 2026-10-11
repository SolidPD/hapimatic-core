// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef } from "react";
import type { PermissionModeOption } from "@hapi/protocol";
import {
  PopOutEditorShell,
  EditorSessionName,
  popOutWindowTitle,
  type PopOutOrigin,
} from "@/components/PopOutEditorShell";
import {
  usePromptEditor,
  PromptEditorToolbar,
  PromptEditorBody,
} from "@/components/AssistantChat/PromptEditorBody";
import { usePopOutWindow } from "@/hooks/usePopOutWindow";
import type { ModelMode, PermissionMode } from "@/types/api";

/**
 * usePromptPopOut (#3517 Task 8) — hosts the prompt editor's pop-out window.
 *
 * Extracted from HappyComposer so the pop-out window, the shared editor
 * controller, and the shell rendering live in ONE place (and to keep
 * HappyComposer under its max-lines cap). Returns:
 *  - `onPopOut`               — the inline field's trigger (opens full-height +
 *                               auto-collapses, R4);
 *  - `onPopOutFromFullscreen` — the fullscreen editor's trigger: same pop-out,
 *                               but Pop-in docks back INTO the fullscreen editor;
 *  - `shell`                  — the PopOutEditorShell JSX; the caller renders it
 *                               as a sibling of its collapse ternary so it
 *                               survives the auto-collapse (renders null when
 *                               not popped out — R2).
 * Both triggers are `undefined` where there is no pop-out (a touch surface),
 * so a host renders the button by presence alone.
 *
 * The window's onClose owns collapse/restore. Restore is LOCAL-ONLY
 * (setIsComposerExpanded) — never the persisted onPromptCollapseChange, whose
 * synchronous write would flip suppressCollapsedHeading and unmount the host
 * (and the pop-out window) — KD-6.
 */
type UsePromptPopOutParams = {
  /** Touch surfaces get no pop-out trigger (I3-R1). */
  isTouch: boolean;
  /** The session this prompt belongs to — shown in the window's heading + title. */
  sessionName?: string;
  /**
   * The composer's Session Config Cluster, rendered in the footer in place of
   * the legacy text pickers — the same chips the fullscreen editor shows. A tap
   * opens the Session Configuration modal in the MAIN window (its dialog
   * portals to the opener's document, like the Clear confirm).
   */
  configCluster?: React.ReactNode;
  // Collapse control (host state) — R4 collapse/restore, local-only (KD-6).
  isComposerExpanded: boolean;
  setIsComposerExpanded: (v: boolean) => void;
  setShowFullscreenPrompt: (v: boolean) => void;
  onOpenHaptic?: () => void;
  // Editor core (the same values the fullscreen modal receives).
  text: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  canSend: boolean;
  controlsDisabled: boolean;
  onSend: () => void;
  onComposeFocus?: () => void;
  // Toolbar attachment.
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  onAttachmentClick?: () => void;
  // Footer (ComposerButtons).
  showAbortButton: boolean;
  abortDisabled: boolean;
  isAborting: boolean;
  abortQueued: boolean;
  onAbort: () => void;
  showSwitchButton: boolean;
  switchDisabled: boolean;
  isSwitching: boolean;
  onSwitch: () => void;
  queueLength?: number;
  onQueueIndicatorClick?: () => void;
  // Pickers.
  permissionMode?: PermissionMode;
  modelMode?: ModelMode;
  resolvedModel?: string;
  agentFlavor?: string | null;
  permissionModeOptions?: PermissionModeOption[];
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onModelModeChange?: (mode: ModelMode) => void;
  // Paste + drag (drop wired explicitly — the pop-out renders OUTSIDE the
  // composer's dropZoneRef, so the synthetic-event bubbling is gone; #3517 T5).
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragEnter?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragLeave?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
};

export function usePromptPopOut(params: UsePromptPopOutParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const priorExpandedRef = useRef<boolean | null>(null);
  const originRef = useRef<PopOutOrigin>("inline");
  const closedProgrammaticallyRef = useRef(false);

  const win = usePopOutWindow({
    fullHeight: true,
    title: popOutWindowTitle("Prompt", params.sessionName),
    onClose: () => {
      // Fires on a Pop-in / window close OR a programmatic (send) close.
      // Distinguish so a send does NOT restore.
      if (closedProgrammaticallyRef.current) {
        closedProgrammaticallyRef.current = false;
        priorExpandedRef.current = null;
        return;
      }
      const p = paramsRef.current;
      if (originRef.current === "fullscreen") {
        // Popped out of the fullscreen editor → dock back INTO it. Its Dialog
        // is mounted in the composer's expanded branch, so expand first.
        p.setIsComposerExpanded(true);
        p.setShowFullscreenPrompt(true);
      } else if (priorExpandedRef.current !== null) {
        p.setIsComposerExpanded(priorExpandedRef.current);
      }
      priorExpandedRef.current = null;
    },
  });

  const popOut = useCallback(
    (origin: PopOutOrigin) => {
      const p = paramsRef.current;
      // A blocked window leaves the editor where it is.
      if (!win.open()) return;
      originRef.current = origin;
      priorExpandedRef.current = p.isComposerExpanded;
      // Local-only collapse (KD-6): setIsComposerExpanded ONLY.
      p.setIsComposerExpanded(false);
      p.setShowFullscreenPrompt(false); // R2 — no Radix Dialog behind the pop-out.
      p.onOpenHaptic?.();
    },
    [win]
  );
  // Zero-arg triggers: both are handed to onClick, which would otherwise pass
  // its event object in as the origin.
  const onPopOut = useCallback(() => popOut("inline"), [popOut]);
  const onPopOutFromFullscreen = useCallback(
    () => popOut("fullscreen"),
    [popOut]
  );

  const onSendFromPopOut = useCallback(() => {
    paramsRef.current.onSend();
    if (win.isOpen) {
      closedProgrammaticallyRef.current = true;
      win.close();
    }
  }, [win]);

  const onRequestClose = useCallback(() => win.close(), [win]);

  const editor = usePromptEditor({
    active: win.isOpen,
    text: params.text,
    onChange: params.onChange,
    disabled: params.disabled,
    canSend: params.canSend,
    controlsDisabled: params.controlsDisabled,
    onSend: onSendFromPopOut,
    onRequestClose,
    onComposeFocus: params.onComposeFocus,
  });

  const shell = (
    <PopOutEditorShell
      win={win}
      title={
        <>
          <h2 className="shrink-0 text-base font-semibold">Prompt</h2>
          <EditorSessionName name={params.sessionName} />
        </>
      }
      toolbar={
        <PromptEditorToolbar
          controller={editor}
          attachmentCount={params.attachmentCount}
          hasInvalidFiles={params.hasInvalidFiles}
          onAttachmentClick={params.onAttachmentClick}
        />
      }
      onRequestClose={onRequestClose}
    >
      <PromptEditorBody
        controller={editor}
        showAbortButton={params.showAbortButton}
        abortDisabled={params.abortDisabled}
        isAborting={params.isAborting}
        abortQueued={params.abortQueued}
        onAbort={params.onAbort}
        showSwitchButton={params.showSwitchButton}
        switchDisabled={params.switchDisabled}
        isSwitching={params.isSwitching}
        onSwitch={params.onSwitch}
        queueLength={params.queueLength}
        onQueueIndicatorClick={params.onQueueIndicatorClick}
        permissionMode={params.permissionMode}
        modelMode={params.modelMode}
        resolvedModel={params.resolvedModel}
        agentFlavor={params.agentFlavor}
        permissionModeOptions={params.permissionModeOptions}
        onPermissionModeChange={params.onPermissionModeChange}
        onModelModeChange={params.onModelModeChange}
        configCluster={params.configCluster}
        onPaste={params.onPaste}
        onDragOver={params.onDragOver}
        onDragEnter={params.onDragEnter}
        onDragLeave={params.onDragLeave}
        onDrop={params.onDrop}
      />
    </PopOutEditorShell>
  );

  const canPopOut = win.isSupported && !params.isTouch;
  return {
    isOpen: win.isOpen,
    onPopOut: canPopOut ? onPopOut : undefined,
    onPopOutFromFullscreen: canPopOut ? onPopOutFromFullscreen : undefined,
    shell,
  };
}
