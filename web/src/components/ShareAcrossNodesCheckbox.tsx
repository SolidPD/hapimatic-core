// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from "react";
import { Checkbox } from "@/components/ui/Checkbox";

/** Issue #5127: the helper line under the checkbox — one copy for every add form. */
export const SHARE_ACROSS_NODES_HELP =
  "Sessions on your other federation nodes can use this key. It stays stored on this node.";

/**
 * Issue #5127: the "Make available to all nodes" checkbox an Anthropic key's
 * add form shows (the "+ Add" modal, the Settings add form and the chat
 * registration card). Each form initialises it from the
 * `shareApiKeysByDefault` preference and sends its value explicitly as
 * `shareAcrossNodes` with every add (D7).
 */
export function ShareAcrossNodesCheckbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5" data-testid="share-across-nodes">
      <label
        htmlFor={id}
        className="flex cursor-pointer items-center gap-2 text-[length:var(--text-label-strong)] text-[var(--app-fg)]"
      >
        <Checkbox
          id={id}
          checked={props.checked}
          disabled={props.disabled}
          onChange={e => props.onChange(e.target.checked)}
        />
        Make available to all nodes
      </label>
      <p className="pl-6 text-[length:var(--text-caption)] text-[var(--app-hint)]">
        {SHARE_ACROSS_NODES_HELP}
      </p>
    </div>
  );
}
