// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, OutputStyleInfo } from "@/api/client";
import { useDefaultOutputStyle } from "@/hooks/useDefaultOutputStyle";
import { useOutputStyles } from "@/hooks/queries/useOutputStyles";
import { DEFAULT_OUTPUT_STYLE_DEFAULT } from "@hapi/protocol/schemas";

/**
 * Per-session output-style selection state for the Create page (#2626 Sub-Issue
 * D; extracted from `index.tsx` for #2930). Owns the style catalog query, the
 * saved-default pre-fill, and the `outputStyleTouched` guard that stops a late
 * async default reconcile (a server read that resolves after mount) from
 * clobbering a manual pick / bookmark restore — mirroring the
 * launcher/globalDefaultLauncher guard in `index.tsx`.
 *
 * The returned `setOutputStyle` is TOUCH-MARKING: it records the value AND flips
 * the touched guard, so every user/bookmark write routes through one setter.
 * A caller that also tracks generic form-field dirtiness still calls its own
 * `markTouched("outputStyle")` alongside it — that concern is separate from this
 * hook's pre-fill guard.
 */
export function useOutputStyleSelection(api: ApiClient | null): {
  /** Currently-selected style name (built-in or hub-local custom). */
  outputStyle: string;
  /** The catalog backing the dropdown (built-ins + customs). */
  outputStyles: OutputStyleInfo[];
  /** Touch-marking setter: records the pick AND guards it against a later
   *  async default reconcile clobbering it. */
  setOutputStyle: (value: string) => void;
} {
  // #2626 (D): per-session output style. The catalog (built-ins + hub-local
  // customs) backs the dropdown; the value is pre-selected from the user's saved
  // default (#2623). `outputStyleTouched` guards the pre-fill so a later default
  // reconcile (async server read) never clobbers a manual pick / bookmark restore
  // — exactly the launcher/globalDefaultLauncher guard in index.tsx.
  const { style: defaultOutputStyle } = useDefaultOutputStyle(api);
  const { styles: outputStyles } = useOutputStyles(api);
  const [outputStyle, setOutputStyleRaw] = useState<string>(
    DEFAULT_OUTPUT_STYLE_DEFAULT
  );
  const [outputStyleTouched, setOutputStyleTouched] = useState(false);

  useEffect(() => {
    if (!outputStyleTouched) setOutputStyleRaw(defaultOutputStyle);
  }, [defaultOutputStyle, outputStyleTouched]);

  const setOutputStyle = useCallback((value: string) => {
    setOutputStyleTouched(true);
    setOutputStyleRaw(value);
  }, []);

  return { outputStyle, outputStyles, setOutputStyle };
}
