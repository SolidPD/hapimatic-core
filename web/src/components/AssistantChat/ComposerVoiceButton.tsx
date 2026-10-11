// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Composer wiring for voice input (issue #4707), kept out of HappyComposer.
 *
 * Rendered inside the composer (assistant-ui runtime context). The transcript
 * is inserted at the textarea's CURRENT cursor — or replaces its selection —
 * against the live composer text, so anything typed while a transcription was
 * in flight is kept. It is NEVER sent: the user edits, then sends. Renders
 * nothing when voice input is not available on this node.
 */
import { useCallback, type RefObject } from "react";
import { useAssistantApi, useAssistantState } from "@assistant-ui/react";
import { VoiceInputButton } from "@/components/AssistantChat/VoiceInputButton";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { useAppContext } from "@/lib/app-context";
import { insertTranscript } from "@/lib/voiceInsert";

export function ComposerVoiceButton(props: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}) {
  const { api: apiClient } = useAppContext();
  const assistant = useAssistantApi();
  const threadDisabled = useAssistantState(({ thread }) => thread.isDisabled);
  const textareaRef = props.inputRef;

  const onTranscript = useCallback(
    (transcript: string) => {
      const text = assistant.composer().getState().text;
      const el = textareaRef.current;
      const selection = el
        ? { start: el.selectionStart, end: el.selectionEnd }
        : { start: text.length, end: text.length };
      const result = insertTranscript(text, selection, transcript);
      assistant.composer().setText(result.text);
      setTimeout(() => {
        textareaRef.current?.setSelectionRange(result.cursor, result.cursor);
      }, 0);
    },
    [assistant, textareaRef]
  );

  const voice = useVoiceInput({ api: apiClient, onTranscript });
  if (!voice.available) return null;
  return (
    <VoiceInputButton
      state={voice.state}
      elapsedMs={voice.elapsedMs}
      error={voice.error}
      disabled={Boolean(props.disabled) || threadDisabled}
      onToggle={voice.toggle}
      onDismissError={voice.clearError}
    />
  );
}
