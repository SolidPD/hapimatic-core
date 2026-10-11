// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect } from "react";
import { loadPdfDocument, renderPageToDataUrl } from "@/lib/pdf";

/**
 * Render the first page of a PDF as a thumbnail data URL.
 *
 * Lazily loads pdf.js only when called. Returns null while loading
 * or if rendering fails (graceful degradation to file icon).
 */
export function usePdfThumbnail(source: string | File | null): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setDataUrl(null);
      return;
    }

    let cancelled = false;

    async function render() {
      try {
        let input: string | ArrayBuffer;
        if (source instanceof File) {
          input = await source.arrayBuffer();
        } else {
          input = source as string;
        }

        if (cancelled) return;

        const doc = await loadPdfDocument(input);
        if (cancelled) {
          doc.destroy();
          return;
        }

        const page = await doc.getPage(1);
        if (cancelled) {
          doc.destroy();
          return;
        }

        // Render at thumbnail size (160px wide — 2x the 80px display for retina)
        const url = await renderPageToDataUrl(page, 160);
        if (!cancelled) {
          setDataUrl(url);
        }

        doc.destroy();
      } catch {
        // Silently fail — fallback to generic PDF icon
        if (!cancelled) setDataUrl(null);
      }
    }

    render();

    return () => {
      cancelled = true;
    };
  }, [source]);

  return dataUrl;
}
