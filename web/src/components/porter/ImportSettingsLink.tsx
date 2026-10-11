// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ApiError } from "@/api/client";
import type {
  ImportPlanSummary,
  SymlinkedSettingsRefusal,
} from "@/types/porter";

/**
 * #4277 — the import review's Destination section and the symlinked
 * settings.json acknowledgement (#4146's 409), split out of PorterImportPanel.tsx
 * to keep that file under the 1,500-line max-lines cap (#2077). All colours come
 * from design tokens (never hardcoded), matching the panel's existing usage.
 */

type LinkReason = SymlinkedSettingsRefusal["reason"];

const LINK_REASONS: readonly LinkReason[] = [
  "outside-root",
  "dangling",
  "loop",
  "not-regular",
];

/**
 * Why a settings.json link cannot be written through, in BOTH vocabularies: the
 * plan's `settingsLink.state` says `outside`, the 409's `reason` says
 * `outside-root`. MIRROR of `SYMLINK_REASON_TEXT` in
 * `server/src/porter/importArchiveErrors.ts`.
 */
const LINK_REASON_TEXT: Record<LinkReason | "outside", string> = {
  outside: "it points outside the config root",
  "outside-root": "it points outside the config root",
  dangling: "it does not resolve to a file",
  loop: "it is part of a symlink loop",
  "not-regular": "it does not point at a regular file",
};

/**
 * The `symlinkedSettings` echo of a commit refused with 409, or `null` for any
 * other error: not an `ApiError`, not a 409, a non-JSON body, another 409 (the
 * #3590 `registryMissing` echo), or a malformed echo. Fails closed, so no
 * acknowledgement control is offered for a refusal it cannot read. `target` is
 * returned exactly as the server sent it (never trimmed or normalised), because
 * the server compares the acknowledgement with `readlink` byte for byte.
 */
export function parseSymlinkedSettingsRefusal(
  err: unknown
): SymlinkedSettingsRefusal | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.body) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(err.body);
  } catch {
    return null;
  }
  const link = (body as { symlinkedSettings?: unknown } | null)
    ?.symlinkedSettings;
  if (typeof link !== "object" || link === null) return null;
  const { linkPath, target, reason } = link as Record<string, unknown>;
  if (typeof linkPath !== "string" || linkPath === "") return null;
  if (typeof target !== "string" || target === "") return null;
  if (!LINK_REASONS.includes(reason as LinkReason)) return null;
  return { linkPath, target, reason: reason as LinkReason };
}

/**
 * The acknowledgement state for one 409 refusal, bound to the plan it was
 * received for. `capture` records a failed commit: a well-formed echo opens the
 * gate unticked, any other error closes it. A refusal from another plan (another
 * staging handle) is never shown and never sent. `reset()` runs on every new plan
 * and on "Import another".
 */
export function useSettingsLinkAck(): {
  acked: boolean;
  capture: (err: unknown, stagingHandle: string) => void;
  toggle: () => void;
  reset: () => void;
  /** The refusal to show for the plan under review, or `null`. */
  liveFor: (stagingHandle?: string) => SymlinkedSettingsRefusal | null;
  /** `acknowledgeSymlinkedSettings` for this plan: the echoed target, only once ticked. */
  ackFor: (stagingHandle?: string) => string | undefined;
} {
  const [refusal, setRefusal] = useState<{
    stagingHandle: string;
    link: SymlinkedSettingsRefusal;
  } | null>(null);
  const [acked, setAcked] = useState(false);
  const liveFor = (stagingHandle?: string) =>
    refusal !== null && refusal.stagingHandle === stagingHandle
      ? refusal.link
      : null;
  return {
    acked,
    capture: (err, stagingHandle) => {
      const link = parseSymlinkedSettingsRefusal(err);
      setRefusal(link ? { stagingHandle, link } : null);
      setAcked(false);
    },
    toggle: () => setAcked(a => !a),
    reset: () => {
      setRefusal(null);
      setAcked(false);
    },
    liveFor,
    ackFor: stagingHandle => {
      const link = liveFor(stagingHandle);
      return link && acked ? link.target : undefined;
    },
  };
}

/**
 * The 409 acknowledgement gate. Shows the link, its target and why the merge
 * will not write through it, and ONE checkbox that allows replacing it. The
 * panel keeps Import disabled until it is ticked. Paths render as React text,
 * never as HTML.
 */
export function SymlinkedSettingsGate({
  link,
  acknowledged,
  onToggle,
}: {
  link: SymlinkedSettingsRefusal;
  acknowledged: boolean;
  onToggle: () => void;
}) {
  return (
    <section
      data-testid="symlinked-settings-gate"
      className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2"
    >
      <h3 className="flex items-center gap-1.5 pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-hot">
        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
        settings.json is a symlink
      </h3>
      <p className="break-all pb-1 font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
        <span data-testid="symlinked-settings-link">{link.linkPath}</span>
        {" → "}
        <span data-testid="symlinked-settings-target">{link.target}</span>
      </p>
      <p
        className="pb-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        data-testid="symlinked-settings-reason"
      >
        Nothing was imported: settings.json is a symlink, and{" "}
        {LINK_REASON_TEXT[link.reason]}. Importing now replaces the link with a
        regular file, and <span className="font-mono">{link.target}</span> stops
        receiving changes. To keep the link, import into the config root that
        holds its target instead.
      </p>
      <label className="flex cursor-pointer items-center gap-2 text-[length:var(--text-body-dense)] text-[var(--app-fg)]">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={onToggle}
          data-testid="ack-symlinked-settings"
        />
        Replace this link with a regular file
      </label>
    </section>
  );
}

/**
 * #4146 / #4277 (R4): the plan-time `settingsLink` row. Informational only: the
 * commit decides on the operator's selection, and a plan whose selection merges
 * nothing into settings.json leaves the link alone, so a link that will not be
 * written through is described as "asks before replacing", never "will be
 * replaced".
 */
function SettingsLinkRow({
  link,
}: {
  link: NonNullable<ImportPlanSummary["settingsLink"]>;
}) {
  const inside = link.state === "inside";
  const note =
    link.state === "inside"
      ? "A link inside the config root: the merge writes through it and keeps the link."
      : `The merge cannot write through this link, because ${LINK_REASON_TEXT[link.state]}. If the import writes settings.json, it asks before replacing the link.`;
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-24 shrink-0 text-[length:var(--text-caption)] uppercase text-[var(--app-hint)]">
        Settings link
      </dt>
      <dd
        className="min-w-0 flex-1 text-[length:var(--text-body-dense)]"
        data-testid="dest-settings-link"
      >
        <span className="break-all font-mono text-[var(--app-fg)]">
          settings.json → {link.target}
        </span>
        <span
          className={`block ${inside ? "text-[var(--app-hint)]" : "text-warn"}`}
        >
          {note}
        </span>
      </dd>
    </div>
  );
}

/**
 * Destination — where a commit will write (#2620 / F6). A same-machine instance
 * resolves to the host ~/.claude; it is NOT a fresh destination unless
 * CLAUDE_CONFIG_DIR redirects the root.
 */
export function ImportDestination({
  summary,
  isolated,
}: {
  summary: ImportPlanSummary;
  isolated: boolean;
}) {
  return (
    <section data-testid="import-destination">
      <h3 className="pb-1 text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
        Destination
      </h3>
      <p className="pb-1.5 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        {isolated ? (
          <>
            Isolated destination — the live{" "}
            <span className="font-mono">~/.claude</span> is not touched;
            per-account propagation is skipped.
          </>
        ) : (
          <>
            A commit writes to these paths on this instance&apos;s host. A
            same-machine instance is not a fresh destination.
          </>
        )}
      </p>
      <dl className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <dt className="w-24 shrink-0 text-[length:var(--text-caption)] uppercase text-[var(--app-hint)]">
            Config dir
          </dt>
          <dd
            className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
            data-testid="dest-claude-dir"
            title={summary.claudeDir}
          >
            {summary.claudeDir}
          </dd>
        </div>
        <div className="flex items-baseline gap-2">
          <dt className="w-24 shrink-0 text-[length:var(--text-caption)] uppercase text-[var(--app-hint)]">
            MCP config
          </dt>
          <dd
            className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
            data-testid="dest-host-config"
            title={summary.hostConfigPath}
          >
            {summary.hostConfigPath}
          </dd>
        </div>
        {summary.settingsLink && (
          <SettingsLinkRow link={summary.settingsLink} />
        )}
      </dl>
    </section>
  );
}
