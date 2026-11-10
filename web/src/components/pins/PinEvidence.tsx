// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, type FC, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { PinEvidence as PinEvidenceItem } from "@hapi/protocol";
import { DiffView } from "@/components/DiffView";
import { HoverTooltip } from "@/components/ui/tooltip";
import {
  FilePreview,
  base64ToBytes,
  previewKindFor,
} from "@/extensions/git-rpc/browse/preview/FilePreview";
import { usePinsContext } from "@/components/pins/pinsShared";
import { queryKeys } from "@/lib/query-keys";
import { splitUnifiedDiff } from "@/lib/unifiedDiff";
import { decodeBase64, encodeBase64 } from "@/lib/utils";
import type { FileReadResponse } from "@/types/api";

/** Larger images show as a link to the file viewer instead of decoding. */
export const PIN_IMAGE_INLINE_MAX_BYTES = 2 * 1024 * 1024;
/** Evidence bytes leave memory 30 s after their pin collapses. */
const EVIDENCE_GC_MS = 30_000;

export type PinEvidenceProps = {
  sessionId: string;
  evidence: PinEvidenceItem;
  revision: number;
};

/** `path` without its trailing slashes (a loop: `/\/+$/` is quadratic). */
export function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 0x2f) end--;
  return path.slice(0, end);
}

/** The folder a working-tree path sits in, or "" for one at the root. */
export function parentFolder(path: string): string {
  const trimmed = trimTrailingSlashes(path);
  const cut = trimmed.lastIndexOf("/");
  return cut > 0 ? trimmed.slice(0, cut) : "";
}

/**
 * A labeled link to the file in the session's file viewer. #6453: it carries the
 * file's folder as `dir`, so Back from the viewer lands on the Files tab there.
 */
export function FileViewerLink(props: {
  sessionId: string;
  path: string;
  label?: string;
  tooltip?: string;
}) {
  const dir = parentFolder(props.path);
  return (
    <HoverTooltip
      content={props.tooltip ?? `Open ${props.path} in the file viewer`}
    >
      <Link
        to="/sessions/$sessionId/file"
        params={{ sessionId: props.sessionId }}
        search={{
          path: encodeBase64(props.path),
          ...(dir ? { dir: encodeBase64(dir) } : {}),
        }}
        className="break-all font-mono text-[length:var(--text-body-dense)] underline decoration-dotted underline-offset-2"
        style={{ color: "var(--view-accent-files)" }}
      >
        {props.label ?? props.path}
      </Link>
    </HoverTooltip>
  );
}

/** "<reason>:" and a file-viewer link to the path, for evidence that cannot render. */
function EvidenceNote(props: {
  sessionId: string;
  path: string;
  reason: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
      <span>{props.reason}:</span>
      <FileViewerLink sessionId={props.sessionId} path={props.path} />
    </div>
  );
}

/** One evidence file, read through the session (a session RPC). */
function useEvidenceFile(sessionId: string, path: string, revision: number) {
  const { api, sessionActive } = usePinsContext();
  return useQuery<FileReadResponse>({
    queryKey: queryKeys.pinEvidence(sessionId, path, revision),
    queryFn: async () => {
      if (!api) throw new Error("Session unavailable");
      return await api.readSessionFile(sessionId, path);
    },
    enabled: Boolean(api) && sessionActive,
    gcTime: EVIDENCE_GC_MS,
    staleTime: Infinity,
  });
}

/** Shared loading / inactive / failure handling; `render` gets the content. */
function EvidenceFile(props: {
  sessionId: string;
  evidence: PinEvidenceItem;
  revision: number;
  render: (content: string, size: number | undefined) => ReactNode;
}) {
  const { sessionActive } = usePinsContext();
  const { path } = props.evidence;
  const file = useEvidenceFile(props.sessionId, path, props.revision);
  if (!sessionActive) {
    return (
      <EvidenceNote
        sessionId={props.sessionId}
        path={path}
        reason="Shown while the session is running"
      />
    );
  }
  if (file.isPending) {
    return (
      <div className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        Loading {path}…
      </div>
    );
  }
  if (file.isError) {
    return (
      <EvidenceNote
        sessionId={props.sessionId}
        path={path}
        reason={file.error instanceof Error ? file.error.message : "Not shown"}
      />
    );
  }
  const data = file.data;
  if (data.tooLarge) {
    return (
      <EvidenceNote
        sessionId={props.sessionId}
        path={path}
        reason="Too large to show here"
      />
    );
  }
  if (!data.success || data.content === undefined) {
    return (
      <EvidenceNote
        sessionId={props.sessionId}
        path={path}
        reason={data.error ?? "Not shown"}
      />
    );
  }
  return <>{props.render(data.content, data.size)}</>;
}

function ImageBytes(props: {
  sessionId: string;
  path: string;
  content: string;
  revision: number;
}) {
  const bytes = useMemo(() => base64ToBytes(props.content), [props.content]);
  const fileName = props.path.split("/").pop() ?? props.path;
  const preview = bytes ? previewKindFor(fileName, bytes) : null;
  if (!bytes || preview?.kind !== "image") {
    return (
      <EvidenceNote
        sessionId={props.sessionId}
        path={props.path}
        reason="Not shown: not a supported image"
      />
    );
  }
  return (
    // FilePreview renders nothing until its effect has made the blob URL, so
    // the space is reserved; the key resets its "image failed" state when the
    // pin is revised.
    <div style={{ minHeight: "48px" }}>
      <FilePreview
        key={`${props.revision}:${props.path}`}
        fileName={fileName}
        bytes={bytes}
        kind="image"
        mime={preview.mime}
      />
    </div>
  );
}

function ImageEvidence(props: PinEvidenceProps) {
  return (
    <EvidenceFile
      {...props}
      render={(content, size) =>
        size !== undefined && size > PIN_IMAGE_INLINE_MAX_BYTES ? (
          <EvidenceNote
            sessionId={props.sessionId}
            path={props.evidence.path}
            reason="Too large to show here"
          />
        ) : (
          <ImageBytes
            sessionId={props.sessionId}
            path={props.evidence.path}
            content={content}
            revision={props.revision}
          />
        )
      }
    />
  );
}

function DiffFiles(props: {
  sessionId: string;
  path: string;
  content: string;
}) {
  const parsed = useMemo(() => {
    const decoded = decodeBase64(props.content);
    return splitUnifiedDiff(decoded.text);
  }, [props.content]);
  if (parsed.files.length === 0) {
    return (
      <EvidenceNote
        sessionId={props.sessionId}
        path={props.path}
        reason="Not shown: no changes found in this diff"
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {parsed.files.map((file, index) => (
        <DiffView
          key={`${index}:${file.fileName ?? ""}`}
          oldString={file.oldText}
          newString={file.newText}
          filePath={file.fileName}
        />
      ))}
      {parsed.truncated ? (
        <EvidenceNote
          sessionId={props.sessionId}
          path={props.path}
          reason="Diff shortened; open the file for all of it"
        />
      ) : null}
    </div>
  );
}

function DiffEvidence(props: PinEvidenceProps) {
  return (
    <EvidenceFile
      {...props}
      render={content => (
        <DiffFiles
          sessionId={props.sessionId}
          path={props.evidence.path}
          content={content}
        />
      )}
    />
  );
}

function PageEvidence(props: PinEvidenceProps) {
  return (
    <FileViewerLink
      sessionId={props.sessionId}
      path={props.evidence.path}
      label={props.evidence.label ?? props.evidence.path}
      tooltip="Open in the file viewer; the page itself renders once its sandbox ships"
    />
  );
}

/** The fallback for an evidence type this build does not know. */
function LinkEvidence(props: PinEvidenceProps) {
  return (
    <FileViewerLink
      sessionId={props.sessionId}
      path={props.evidence.path}
      label={props.evidence.label ?? props.evidence.path}
    />
  );
}

/**
 * #6449: renderers by evidence type, all Hapimatic's own components, so no
 * agent code runs (R9). K (#6457) overrides `page` with its sandbox; M (#6481)
 * adds chart, video, and audio.
 */
export const evidenceRenderers: Record<string, FC<PinEvidenceProps>> = {
  image: ImageEvidence,
  diff: DiffEvidence,
  page: PageEvidence,
};

/**
 * #6449: a pin's evidence, mounted only while the pin is expanded (so its
 * bytes and blob URLs go when it collapses), each item fetched on its own.
 */
export function PinEvidenceList(props: {
  sessionId: string;
  evidence: readonly PinEvidenceItem[];
  revision: number;
}) {
  if (props.evidence.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {props.evidence.map((item, index) => {
        const Renderer = evidenceRenderers[item.type] ?? LinkEvidence;
        return (
          <div key={`${index}:${item.path}`} className="min-w-0">
            {item.label && item.type !== "page" ? (
              <div className="mb-0.5 text-[length:var(--text-caption)] font-semibold text-[var(--app-hint)]">
                {item.label}
              </div>
            ) : null}
            <Renderer
              sessionId={props.sessionId}
              evidence={item}
              revision={props.revision}
            />
          </div>
        );
      })}
    </div>
  );
}
