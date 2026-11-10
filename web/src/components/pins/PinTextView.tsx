// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #6449 (R11, D8): a pin's stored `plainText`, exactly as the agent wrote it —
 * the fallback every pin carries for any surface that cannot render it.
 */
export function PinTextView(props: { text: string }) {
  return (
    <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
      {props.text}
    </pre>
  );
}
