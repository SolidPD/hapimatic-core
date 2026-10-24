// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from "react";
import { hasHiddenChars, splitHiddenChars } from "./hiddenChars";

/**
 * #5195 — an imported value rendered so the review reads as what runs.
 *
 * Every hidden code point (see `hiddenChars.ts`) renders in place as a
 * `U+XXXX` token, never as the raw character, so its position stays visible
 * (which word it splits). The token is an element, not escape text, so a value
 * that literally contains the characters `U+202E` cannot pose as a token. The
 * value is wrapped in `<bdi dir="ltr">`, so it cannot reorder the labels and
 * badges beside it. `multiline` text (a script preview, pretty-printed JSON)
 * keeps its line feeds and tabs as layout.
 */
export function VisibleText({
  text,
  multiline,
}: {
  text: string;
  multiline?: boolean;
}): ReactElement {
  return (
    <bdi dir="ltr">
      {splitHiddenChars(text, { multiline }).map((seg, i) =>
        seg.kind === "text" ? (
          seg.text
        ) : (
          <span
            key={i}
            data-testid="hidden-char"
            data-codepoint={seg.label}
            title={seg.name}
            className="mx-px rounded border border-current px-0.5 font-mono text-hot"
          >
            {seg.label}
          </span>
        )
      )}
    </bdi>
  );
}

/**
 * A setting value as the review shows it: a string as itself, any other value
 * as pretty-printed JSON. JSON escapes any line feed inside a string, so every
 * line feed in that JSON is layout (#5195).
 */
export const settingValueText = (v: unknown): string =>
  typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? "");

/** A setting value rendered through `VisibleText`; JSON values are multi-line. */
export function SettingValue({ value }: { value: unknown }): ReactElement {
  return (
    <VisibleText
      text={settingValueText(value)}
      multiline={typeof value !== "string"}
    />
  );
}

/**
 * #5195 (R4): one warning line for a review surface when any of its values
 * contains a hidden code point. Renders nothing otherwise. `multilineValues`
 * are checked as multi-line text, matching how they render.
 */
export function HiddenCharsNotice({
  values,
  multilineValues = [],
  testId,
}: {
  values: readonly string[];
  multilineValues?: readonly string[];
  testId: string;
}): ReactElement | null {
  const hidden =
    values.some(v => hasHiddenChars(v)) ||
    multilineValues.some(v => hasHiddenChars(v, { multiline: true }));
  if (!hidden) return null;
  return (
    <p data-testid={testId} className="text-hot">
      Contains hidden or direction-changing characters, shown in place as U+
      codes.
    </p>
  );
}
