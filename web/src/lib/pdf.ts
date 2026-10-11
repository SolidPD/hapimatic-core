// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Lazy-loaded pdf.js wrapper.
 *
 * Dynamically imports pdfjs-dist only when a PDF is actually needed,
 * keeping the ~400KB library out of the main bundle via Vite code-splitting.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

async function getPdfjs(): Promise<typeof import("pdfjs-dist")> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then(pdfjs => {
      // Configure the worker — Vite resolves this to a separate chunk
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** Load a PDF document from a URL or ArrayBuffer. */
export async function loadPdfDocument(
  source: string | ArrayBuffer
): Promise<PDFDocumentProxy> {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument(source);
  return loadingTask.promise;
}

/**
 * Render a PDF page to a canvas and return a data URL.
 *
 * @param page - The PDF page proxy
 * @param maxWidth - Maximum width in CSS pixels (capped for iOS memory safety)
 * @returns data URL of the rendered page
 */
export async function renderPageToDataUrl(
  page: PDFPageProxy,
  maxWidth = 400
): Promise<string> {
  const viewport = page.getViewport({ scale: 1 });

  // Scale to fit maxWidth, capped at 2x device pixel ratio for iOS memory safety
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min((maxWidth * dpr) / viewport.width, 3);
  const scaledViewport = page.getViewport({ scale });

  const canvas = document.createElement("canvas");
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  await page.render({ canvas, canvasContext: ctx, viewport: scaledViewport })
    .promise;

  const dataUrl = canvas.toDataURL("image/png");

  // Clean up — help GC reclaim the canvas memory
  canvas.width = 0;
  canvas.height = 0;

  return dataUrl;
}

/**
 * Render a PDF page directly to a provided canvas element.
 * Used by the multi-page viewer where we keep canvases in the DOM.
 */
export async function renderPageToCanvas(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  containerWidth: number
): Promise<void> {
  const viewport = page.getViewport({ scale: 1 });

  // Scale to fit container width, capped for memory safety
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (containerWidth * dpr) / viewport.width;
  const scaledViewport = page.getViewport({ scale });

  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;
  canvas.style.width = `${containerWidth}px`;
  canvas.style.height = `${scaledViewport.height / dpr}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  await page.render({ canvas, canvasContext: ctx, viewport: scaledViewport })
    .promise;
}
