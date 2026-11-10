// SPDX-License-Identifier: AGPL-3.0-only
import type { PinOption } from "@hapi/protocol";

type DecisionOptionsProps = {
  options: readonly PinOption[];
  recommendedId?: string;
  selectedId?: string;
  disabled?: boolean;
} & (
  | { onSelect?: undefined; name?: undefined }
  | {
      onSelect: (optionId: string) => void;
      /**
       * The radio group's name, unique per rendered copy (`useId`): the same pin
       * can render twice in one document (two chat cards, or a card beside the
       * Pins tab in split view), and radios sharing a name share one group.
       */
      name: string;
    }
);

/**
 * #6449: a decision pin's options with their consequences (mockup v6
 * :293-302). Read-only — no radio — unless `onSelect` is passed, which
 * requires a `name` (#6450). The caller orders the options (the recommended
 * one first, `orderedOptions`).
 */
export function DecisionOptions(props: DecisionOptionsProps) {
  const { options, recommendedId, selectedId, onSelect, disabled } = props;
  const choosing = onSelect !== undefined;
  return (
    <div
      className="mt-1.5 border-t border-[var(--app-divider)]"
      role={choosing ? "radiogroup" : "list"}
    >
      {options.map(option => {
        const selected = selectedId === option.id;
        const content = (
          <>
            {choosing ? (
              <input
                type="radio"
                name={props.name}
                value={option.id}
                checked={selected}
                disabled={disabled}
                onChange={() => onSelect?.(option.id)}
                className="mt-0.5 h-4 w-4 accent-[var(--app-accent)]"
              />
            ) : null}
            <span
              className={`pt-px text-[length:var(--text-body-dense)] font-bold ${
                selected ? "text-[var(--app-accent)]" : "text-[var(--app-hint)]"
              }`}
            >
              {option.id}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5 text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]">
                {option.label}
                {option.id === recommendedId ? (
                  <span
                    className="rounded-sm border px-1 font-bold uppercase tracking-wide text-[var(--app-accent)]"
                    style={{
                      fontSize: "9px",
                      borderColor:
                        "color-mix(in srgb, var(--app-accent) 50%, transparent)",
                    }}
                  >
                    Recommended
                  </span>
                ) : null}
              </span>
              {option.consequence ? (
                <span className="mt-px block text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  {option.consequence}
                </span>
              ) : null}
            </span>
          </>
        );
        const className =
          "grid items-start gap-x-1.5 border-b border-[var(--app-divider)] py-1.5";
        const style = {
          gridTemplateColumns: choosing
            ? "18px 16px minmax(0, 1fr)"
            : "16px minmax(0, 1fr)",
        };
        return choosing ? (
          <label key={option.id} className={className} style={style}>
            {content}
          </label>
        ) : (
          <div
            key={option.id}
            role="listitem"
            className={className}
            style={style}
          >
            {content}
          </div>
        );
      })}
    </div>
  );
}
