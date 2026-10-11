// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useState } from "react";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import { useLauncherStatus } from "@/hooks/queries/useLauncherStatus";

/**
 * Per-session launcher-override selection state for the Create page (#1660;
 * extracted from `index.tsx` for #2930). Defaults to the resolved global default
 * (GET /api/launcher/status); the `launcherTouched` guard stops the async status
 * resolution from clobbering an explicit selection — the same pre-fill guard the
 * output-style hook uses (see {@link useOutputStyleSelection}).
 *
 * `globalDefaultLauncher` is RETURNED (not just consumed internally) because the
 * spawn-command assembly reads it to decide whether to omit the `launcher` flag
 * (its `!== globalDefault` rule). The returned `setLauncher` is TOUCH-MARKING: it
 * records the pick AND flips the guard. A caller that also tracks generic
 * form-field dirtiness still calls its own `markTouched("launcher")` alongside it.
 */
export function useLauncherSelection(): {
  /** The selected launcher (pre-filled from the global default until touched). */
  launcher: ClaudeRemoteLauncherKind;
  /** Resolved global default launcher ("sdk" until GET /api/launcher/status loads). */
  globalDefaultLauncher: ClaudeRemoteLauncherKind;
  /** Touch-marking setter: records the pick AND guards it against the async
   *  default sync clobbering it. */
  setLauncher: (value: ClaudeRemoteLauncherKind) => void;
} {
  const launcherStatus = useLauncherStatus();
  const globalDefaultLauncher = launcherStatus.data?.kind ?? "sdk";
  const [launcher, setLauncherRaw] = useState<ClaudeRemoteLauncherKind>("sdk");
  const [launcherTouched, setLauncherTouched] = useState(false);

  useEffect(() => {
    if (!launcherTouched) setLauncherRaw(globalDefaultLauncher);
  }, [globalDefaultLauncher, launcherTouched]);

  const setLauncher = useCallback((value: ClaudeRemoteLauncherKind) => {
    setLauncherTouched(true);
    setLauncherRaw(value);
  }, []);

  return { launcher, globalDefaultLauncher, setLauncher };
}
