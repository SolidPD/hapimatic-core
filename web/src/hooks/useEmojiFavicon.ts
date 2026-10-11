// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";

export function useEmojiFavicon(emoji: string | null | undefined) {
  const originalFaviconRef = useRef<string | null>(null);

  useEffect(() => {
    const faviconSvg = document.getElementById(
      "favicon-svg"
    ) as HTMLLinkElement | null;

    // Store original favicon on first run
    if (originalFaviconRef.current === null && faviconSvg) {
      originalFaviconRef.current = faviconSvg.href;
    }

    if (!emoji) {
      // Restore original favicon
      if (faviconSvg && originalFaviconRef.current) {
        faviconSvg.href = originalFaviconRef.current;
      }
      return;
    }

    // Create canvas-based emoji favicon
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas with transparent background
    ctx.clearRect(0, 0, 32, 32);

    // Draw emoji centered
    ctx.font = "26px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, 16, 18);

    // Update favicon
    if (faviconSvg) {
      faviconSvg.href = canvas.toDataURL("image/png");
    }

    return () => {
      // Restore original favicon on cleanup
      if (faviconSvg && originalFaviconRef.current) {
        faviconSvg.href = originalFaviconRef.current;
      }
    };
  }, [emoji]);
}
