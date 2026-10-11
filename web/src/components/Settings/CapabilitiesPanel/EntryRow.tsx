// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AnnotatedCatalogEntry } from "@/types/capabilities";

/**
 * EntryRow (issue #3752, Sub-Issue L / R5) — one capability-catalog entry.
 *
 * READ-ONLY + XSS-safe (OR-2 / KD-3): every entry string renders as a React TEXT
 * NODE only. No entry field is ever interpolated into `href`/`src`/`to`/`style` —
 * a filesystem extension can contribute `surface:"ui"` with
 * `invocation.location:"javascript:…"`, so the invocation coordinate is shown as
 * plain text and the "copy" action writes it to the clipboard (an action, never a
 * navigable link). The #3741 schema is the first XSS layer (it rejects `<`/`>`);
 * this text-node rendering is the second.
 */

/** The human-readable invocation coordinate for an entry (TEXT only). */
export function invocationText(entry: AnnotatedCatalogEntry): string {
  const inv = entry.invocation;
  switch (inv.kind) {
    case "rest":
      return `${inv.method} ${inv.path}`;
    case "rpc":
      return inv.method;
    case "mcp":
      return inv.tool;
    case "cli":
      return inv.command;
    case "ui":
      return inv.location;
  }
}

export function EntryRow({ entry }: { entry: AnnotatedCatalogEntry }) {
  const [copied, setCopied] = useState(false);
  const coordinate = invocationText(entry);

  const onCopy = () => {
    // An ACTION, not a link — the coordinate is never rendered as a navigable
    // href/src/to. Guarded for jsdom (no clipboard in the test environment).
    void navigator.clipboard?.writeText?.(coordinate);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const untrusted = entry.trusted === false;

  return (
    <div
      data-testid={`capability-entry-${entry.id}`}
      className="border-t border-[var(--app-border)] px-3 py-2 first:border-t-0"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
              {entry.id}
            </span>
            <span className="rounded border border-[var(--app-border)] px-1 text-[length:var(--text-caption)] text-[var(--app-muted)]">
              {entry.riskTier}
            </span>
            {untrusted ? (
              <span
                data-testid={`capability-untrusted-${entry.id}`}
                className="rounded border border-amber-500/50 px-1 text-[length:var(--text-caption)] text-amber-400"
                title="Contributed by an untrusted (runtime-loaded) extension"
              >
                untrusted extension
              </span>
            ) : null}
            {entry.owner ? (
              <span className="rounded border border-[var(--app-border)] px-1 text-[length:var(--text-caption)] text-[var(--app-muted)]">
                {entry.owner}
              </span>
            ) : null}
            <span
              className={
                entry.available
                  ? "rounded border border-emerald-500/50 px-1 text-[length:var(--text-caption)] text-emerald-400"
                  : "rounded border border-[var(--app-border)] px-1 text-[length:var(--text-caption)] text-[var(--app-muted)]"
              }
            >
              {entry.available ? "available" : "unavailable"}
            </span>
          </div>
          <p className="mt-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
            {entry.description}
          </p>
          <p className="mt-0.5 font-mono text-[length:var(--text-caption)] text-[var(--app-muted)]">
            {coordinate}
          </p>
          {!entry.available && entry.reason ? (
            <p className="mt-0.5 text-[length:var(--text-caption)] text-amber-400">
              {entry.reason}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid={`capability-copy-${entry.id}`}
          title="Copy invocation"
          aria-label="Copy invocation"
          onClick={onCopy}
          className="shrink-0 text-[var(--app-muted)] hover:bg-[var(--app-secondary-bg)]"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </Button>
      </div>
    </div>
  );
}
