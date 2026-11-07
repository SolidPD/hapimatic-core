// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import { PdfViewerModal } from "@/components/PdfViewerModal";

/**
 * #6224 Task 6: inline preview for the file viewer. Images render in `<img>` and
 * PDFs open in the existing pdf.js viewer, both from a blob URL made from the
 * content the viewer already fetched. A blob URL takes the type given here, not
 * any response header, so the type always comes from an allowlist and an image
 * is never navigated to as a document (an SVG drawn by `<img>` cannot run script).
 */

export type PreviewKind = "image" | "pdf";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * Where a format has a fixed signature, the bytes must carry it, so a `.png`
 * that is really text falls through to the text view instead of a broken image.
 */
function signatureMatches(kind: string, bytes: Uint8Array): boolean {
  switch (kind) {
    case "png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
    case "jpg":
    case "jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case "bmp":
      return startsWith(bytes, [0x42, 0x4d]);
    case "pdf":
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
    default:
      // svg (text), avif / heic (ISO-BMFF): no single fixed prefix.
      return true;
  }
}

export function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** The preview a file gets, or null when it is shown as text or not at all. */
export function previewKindFor(
  fileName: string,
  bytes: Uint8Array | null
): { kind: PreviewKind; mime: string } | null {
  if (!bytes || bytes.length === 0) return null;
  const ext = extensionOf(fileName);
  if (ext === "pdf") {
    return signatureMatches("pdf", bytes)
      ? { kind: "pdf", mime: "application/pdf" }
      : null;
  }
  const mime = IMAGE_TYPES[ext];
  if (!mime || !signatureMatches(ext, bytes)) return null;
  return { kind: "image", mime };
}

function useBlobUrl(bytes: Uint8Array, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = new Blob([bytes as BlobPart], { type: mime });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    // Revoked when the file or the page goes away, never right after use.
    return () => URL.revokeObjectURL(next);
  }, [bytes, mime]);
  return url;
}

export function FilePreview(props: {
  fileName: string;
  bytes: Uint8Array;
  kind: PreviewKind;
  mime: string;
  onDownload?: () => void;
}) {
  const url = useBlobUrl(props.bytes, props.mime);
  const [imageFailed, setImageFailed] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const sizeLabel = useMemo(() => {
    const kb = props.bytes.length / 1024;
    return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
  }, [props.bytes.length]);

  if (!url) return null;

  if (props.kind === "image") {
    if (imageFailed) {
      return (
        <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 text-sm text-[var(--app-hint)]">
          <p className="mb-2">This browser cannot show this image.</p>
          {props.onDownload ? (
            <button
              type="button"
              onClick={props.onDownload}
              className="rounded px-3 py-1 text-xs font-semibold bg-[var(--app-button)] text-[var(--app-button-text)]"
            >
              Download
            </button>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2">
        <img
          src={url}
          alt={props.fileName}
          onError={() => setImageFailed(true)}
          className="h-auto max-h-[70vh] max-w-full object-contain"
        />
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 text-sm">
      <div className="mb-3 text-[var(--app-hint)]">
        PDF document · {sizeLabel}
      </div>
      <button
        type="button"
        onClick={() => setPdfOpen(true)}
        className="rounded px-3 py-1 text-xs font-semibold bg-[var(--app-button)] text-[var(--app-button-text)]"
      >
        Open PDF
      </button>
      <PdfViewerModal
        src={url}
        filename={props.fileName}
        open={pdfOpen}
        onOpenChange={setPdfOpen}
      />
    </div>
  );
}
