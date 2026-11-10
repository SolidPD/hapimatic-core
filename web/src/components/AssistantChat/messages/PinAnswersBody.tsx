// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, type ReactNode } from "react";
import { parsePinAnswersMessage, type PinAnswersEntry } from "@hapi/protocol";

function describe(entry: PinAnswersEntry): string {
  const parts: string[] = [];
  if (entry.answer) {
    parts.push(`${entry.answer.choice}. ${entry.answer.label}`);
    // #6452: an answer beside an automatic pick was made by the deadline.
    if (entry.automaticPick) parts.push("automatic");
  } else if (entry.automaticPick) {
    // #6452: the operator moved or stopped the pick (`PinAutomaticPick`).
    parts.push(
      "off" in entry.automaticPick
        ? "automatic pick off"
        : `automatic pick moved to ${entry.automaticPick.local}`
    );
  }
  if (entry.steps) parts.push(`steps ${entry.steps.done}/${entry.steps.total}`);
  const questions = entry.questions?.length ?? 0;
  if (questions > 0) {
    parts.push(`${questions} question${questions === 1 ? "" : "s"}`);
  }
  if (entry.note) parts.push("note");
  return parts.join(" · ");
}

/** The compact body of a `hapi_pin_answers` message (lazy chunk). */
export default function PinAnswersBody(props: {
  text: string;
  fallback: ReactNode;
}) {
  const parsed = useMemo(
    () => parsePinAnswersMessage(props.text),
    [props.text]
  );
  if (!parsed.ok) return <>{props.fallback}</>;
  const summary = props.text.split("\n", 1)[0] ?? "";
  const start = props.text.indexOf("```hapi_pin_answers");
  const raw = start >= 0 ? props.text.slice(start) : props.text;
  const pins = parsed.block.pins;
  return (
    <div data-pin-answers>
      <p className="whitespace-pre-wrap break-words">{summary}</p>
      <details className="mt-1">
        <summary className="cursor-pointer text-[var(--app-hint)]">
          Answers ({pins.length})
        </summary>
        <ul className="mt-1 grid gap-0.5">
          {pins.map((entry, index) => (
            <li key={`${entry.pin}:${index}`} className="min-w-0 truncate">
              <span className="font-semibold">{entry.pin}</span>
              {describe(entry) ? ` → ${describe(entry)}` : null}
            </li>
          ))}
        </ul>
        <details className="mt-1">
          <summary className="cursor-pointer text-[var(--app-hint)]">
            Raw block
          </summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap text-xs">
            {raw}
          </pre>
        </details>
      </details>
    </div>
  );
}
