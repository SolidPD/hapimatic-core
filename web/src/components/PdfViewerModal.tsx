// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useEffect, useRef, useCallback } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { loadPdfDocument, renderPageToCanvas } from "@/lib/pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

interface PdfViewerModalProps {
  src: string;
  filename: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Fullscreen scrollable multi-page PDF viewer.
 *
 * Lazily loads pdf.js, renders each page to a canvas element,
 * and allows vertical scrolling through the entire document.
 */
export function PdfViewerModal({
  src,
  filename,
  open,
  onOpenChange,
}: PdfViewerModalProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load PDF document when modal opens
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const pdfDoc = await loadPdfDocument(src);
        if (cancelled) {
          pdfDoc.destroy();
          return;
        }
        setDoc(pdfDoc);
        setNumPages(pdfDoc.numPages);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load PDF");
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [open, src]);

  // Cleanup document on close
  useEffect(() => {
    if (!open && doc) {
      doc.destroy();
      setDoc(null);
      setNumPages(0);
    }
  }, [open, doc]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/90 backdrop-blur-sm" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex flex-col"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">
            {filename}
          </DialogPrimitive.Title>

          {/* Header bar */}
          <div
            className="flex items-center justify-between px-4 py-2 bg-black/50 text-white"
            style={{
              paddingTop: "max(0.5rem, env(safe-area-inset-top, 0.5rem))",
            }}
          >
            <span className="text-sm truncate flex-1 mr-4">{filename}</span>
            {numPages > 0 && (
              <span className="text-xs text-white/60 mr-4 shrink-0">
                {numPages} page{numPages !== 1 ? "s" : ""}
              </span>
            )}
            <DialogPrimitive.Close
              className="rounded-full bg-black/50 p-2 text-white hover:bg-black/70 transition-colors min-w-[var(--control-touch)] min-h-[var(--control-touch)] flex items-center justify-center shrink-0"
              aria-label="Close"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </DialogPrimitive.Close>
          </div>

          {/* Scrollable page area */}
          <div
            ref={containerRef}
            className="flex-1 overflow-y-auto overflow-x-hidden"
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0)" }}
          >
            {loading && (
              <div className="flex items-center justify-center h-full text-white/60">
                <svg
                  className="animate-spin mr-2"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
                </svg>
                Loading PDF...
              </div>
            )}

            {error && (
              <div className="flex items-center justify-center h-full text-red-400 px-4 text-center">
                <p>Failed to load PDF: {error}</p>
              </div>
            )}

            {doc && !loading && !error && (
              <div className="flex flex-col items-center gap-2 p-2">
                {Array.from({ length: numPages }, (_, i) => (
                  <PdfPage
                    key={i}
                    doc={doc}
                    pageNumber={i + 1}
                    containerRef={containerRef}
                  />
                ))}
              </div>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Individual PDF page component. Renders to a canvas when scrolled into view
 * using IntersectionObserver for lazy rendering.
 */
function PdfPage({
  doc,
  pageNumber,
  containerRef,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);

  // Get page dimensions for placeholder sizing
  useEffect(() => {
    let cancelled = false;
    doc.getPage(pageNumber).then(page => {
      if (cancelled) return;
      const vp = page.getViewport({ scale: 1 });
      setAspectRatio(vp.width / vp.height);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber]);

  const renderPage = useCallback(async () => {
    if (rendered || !canvasRef.current) return;
    try {
      const page = await doc.getPage(pageNumber);
      const containerWidth = containerRef.current
        ? Math.min(containerRef.current.clientWidth - 16, 800)
        : 400;
      await renderPageToCanvas(page, canvasRef.current, containerWidth);
      setRendered(true);
    } catch {
      // Silently fail — canvas stays blank
    }
  }, [doc, pageNumber, rendered, containerRef]);

  // IntersectionObserver for lazy rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || rendered) return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) {
          renderPage();
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(canvas);
    return () => observer.disconnect();
  }, [renderPage, rendered]);

  return (
    <canvas
      ref={canvasRef}
      className="max-w-full rounded bg-white"
      style={
        aspectRatio
          ? { aspectRatio: `${aspectRatio}`, width: "100%", maxWidth: "800px" }
          : { width: "100%", maxWidth: "800px", minHeight: "200px" }
      }
    />
  );
}
