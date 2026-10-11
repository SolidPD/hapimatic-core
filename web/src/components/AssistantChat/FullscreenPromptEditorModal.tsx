// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, type ReactNode } from "react";
import type { PermissionModeOption } from "@hapi/protocol";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { CloseIcon, PopOutIcon } from "@/components/ui/icons";
import { TouchButton } from "@/components/ui/TouchButton";
import { EditorSessionName } from "@/components/PopOutEditorShell";
import {
  usePromptEditor,
  PromptEditorToolbar,
  PromptEditorBody,
} from "@/components/AssistantChat/PromptEditorBody";
import type { ModelMode, PermissionMode } from "@/types/api";

type FullscreenPromptEditorModalProps = {
  isOpen: boolean;
  onClose: () => void;
  text: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  // ComposerButtons props for the bottom bar
  canSend: boolean;
  controlsDisabled: boolean;
  onSend: () => void;
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
  // Attachment (paperclip) props
  attachmentCount?: number;
  hasInvalidFiles?: boolean;
  onAttachmentClick?: () => void;
  // Paste parity with the inline composer field. Drop needs no prop here: this
  // modal is rendered INSIDE the composer's drop-zone div and React bubbles
  // synthetic events through portals, so a drop already reaches that zone. (The
  // pop-out surface, hosted OUTSIDE the drop-zone, wires drop handlers by prop —
  // see HappyComposer / #3517 Task 8.)
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  // Picker props (issue #2455)
  permissionMode?: PermissionMode;
  modelMode?: ModelMode;
  resolvedModel?: string;
  agentFlavor?: string | null;
  permissionModeOptions?: PermissionModeOption[];
  onPermissionModeChange?: (mode: PermissionMode) => void;
  onModelModeChange?: (mode: ModelMode) => void;
  // Epic #3285 round 14 (item 2): the composer's Session Config Cluster
  // (Permission · Model · Effort · Account · MCP chips), rendered in the editor
  // footer in place of the legacy text pickers so the fullscreen surface shows
  // the same session controls as the inline composer.
  configCluster?: ReactNode;
  // Called when textarea receives focus — clears "needs review" indicator (#279)
  onComposeFocus?: () => void;
  // The session this prompt belongs to, shown beside the heading: fullscreen
  // covers the thread, so the editor itself has to say whose prompt it is.
  sessionName?: string;
  // Pop this fullscreen editor out to a separate window. The host (HappyComposer
  // via usePromptPopOut) owns the pop-out window + shell and closes this Dialog; it wires
  // the prop only where a pop-out exists, so the button renders by presence.
  onPopOut?: () => void;
};

/**
 * The fullscreen ("Expand") prompt editor Dialog. Since #3517 (KD-1) the pop-out
 * capability is LIFTED OUT of this Dialog up to HappyComposer (which floats the
 * editor directly via PopOutEditorShell), so this component is the
 * fullscreen-edit surface: a Radix Dialog wrapping the shared PromptEditorBody +
 * PromptEditorToolbar, both driven by the shared usePromptEditor controller (R6).
 * Its header carries a Pop-out button (`onPopOut`) that hands the editor to the
 * host's separate window; that window's Pop-in reopens this Dialog.
 */
export function FullscreenPromptEditorModal(
  props: FullscreenPromptEditorModalProps
) {
  const {
    isOpen,
    onClose,
    text,
    onChange,
    disabled = false,
    canSend,
    controlsDisabled,
    onSend,
    showAbortButton,
    abortDisabled,
    isAborting,
    abortQueued,
    onAbort,
    showSwitchButton,
    switchDisabled,
    isSwitching,
    onSwitch,
    queueLength,
    onQueueIndicatorClick,
    attachmentCount = 0,
    hasInvalidFiles = false,
    onAttachmentClick,
    onPaste,
    permissionMode = "default",
    modelMode = "default",
    resolvedModel,
    agentFlavor,
    permissionModeOptions = [],
    onPermissionModeChange,
    onModelModeChange,
    configCluster,
    onComposeFocus,
    sessionName,
    onPopOut,
  } = props;

  // Send from the fullscreen editor: perform the send, then close the Dialog.
  const handleSend = useCallback(() => {
    onSend();
    onClose();
  }, [onSend, onClose]);

  const editor = usePromptEditor({
    active: isOpen,
    text,
    onChange,
    disabled,
    canSend,
    controlsDisabled,
    onSend: handleSend,
    onRequestClose: onClose,
    onComposeFocus,
  });

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent fullscreen className="flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b border-[var(--app-divider)] shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-2">
              <DialogTitle className="shrink-0 text-base font-semibold">
                Prompt
              </DialogTitle>
              <EditorSessionName name={sessionName} />
            </div>
            <DialogDescription className="sr-only">
              Write your message in fullscreen mode
            </DialogDescription>

            {/* Toolbar buttons */}
            <div className="flex shrink-0 items-center gap-2">
              <PromptEditorToolbar
                controller={editor}
                attachmentCount={attachmentCount}
                hasInvalidFiles={hasInvalidFiles}
                onAttachmentClick={onAttachmentClick}
              />

              {/* Divider */}
              <div className="w-px h-4 bg-[var(--app-divider)] mx-1" />

              {/* Pop out to a separate window — only where the host wires it */}
              {onPopOut ? (
                <TouchButton
                  onAction={onPopOut}
                  className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-link)] hover:bg-[var(--app-hover)]"
                  title="Pop out to a separate window"
                >
                  <PopOutIcon className="h-4 w-4" />
                </TouchButton>
              ) : null}

              {/* Close button */}
              <TouchButton
                onAction={onClose}
                className="p-1.5 rounded-full transition-colors text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)]"
                title="Close"
              >
                <CloseIcon className="h-4 w-4" />
              </TouchButton>
            </div>
          </div>
        </DialogHeader>

        <PromptEditorBody
          controller={editor}
          showAbortButton={showAbortButton}
          abortDisabled={abortDisabled}
          isAborting={isAborting}
          abortQueued={abortQueued}
          onAbort={onAbort}
          showSwitchButton={showSwitchButton}
          switchDisabled={switchDisabled}
          isSwitching={isSwitching}
          onSwitch={onSwitch}
          queueLength={queueLength}
          onQueueIndicatorClick={onQueueIndicatorClick}
          permissionMode={permissionMode}
          modelMode={modelMode}
          resolvedModel={resolvedModel}
          agentFlavor={agentFlavor}
          permissionModeOptions={permissionModeOptions}
          onPermissionModeChange={onPermissionModeChange}
          onModelModeChange={onModelModeChange}
          configCluster={configCluster}
          onPaste={onPaste}
        />
      </DialogContent>
    </Dialog>
  );
}
