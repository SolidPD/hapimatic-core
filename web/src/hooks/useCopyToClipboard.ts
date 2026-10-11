// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback } from "react";
import { usePlatform } from "./usePlatform";
import { useToast } from "@/components/Toast";
import { safeCopyToClipboard } from "@/lib/clipboard";

export function useCopyToClipboard(resetDelay = 1500) {
  const [copied, setCopied] = useState(false);
  const { haptic } = usePlatform();
  const { showToast } = useToast();

  const copy = useCallback(
    async (text: string) => {
      console.log("[Copy] Attempting to copy text, length:", text.length);
      try {
        await safeCopyToClipboard(text);
        console.log("[Copy] Success");
        haptic.notification("success");
        setCopied(true);
        setTimeout(() => setCopied(false), resetDelay);
        return true;
      } catch (err) {
        console.error("[Copy] Failed:", err);
        haptic.notification("error");
        showToast("Failed to copy text", { type: "error" });
        return false;
      }
    },
    [haptic, resetDelay, showToast]
  );

  return { copied, copy };
}
