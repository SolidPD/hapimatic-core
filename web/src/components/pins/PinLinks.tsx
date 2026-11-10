// SPDX-License-Identifier: AGPL-3.0-only
import {
  memo,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from "react";
import { Link } from "@tanstack/react-router";
import type { Components, Options } from "react-markdown";
import { Folder, MessageSquareText, Save } from "lucide-react";
import {
  effectiveSavedTo,
  pinFolderName,
  pinFolderPath,
  pinSaveSources,
  resolveIssueRepo,
  type Pin,
  type PinIssueRef,
} from "@hapi/protocol";
import { ApiError } from "@/api/client";
import { IssueInfoModal } from "@/components/IssueInfoModal";
import { useToast } from "@/components/Toast";
import { InlineMarkdownAnchor } from "@/components/assistant-ui/sharedMarkdownComponents";
import { PIN_ACTION_CLASS } from "@/components/pins/PinAnswerControls";
import { trimTrailingSlashes } from "@/components/pins/PinEvidence";
import { usePinsContext } from "@/components/pins/pinsShared";
import { HoverTooltip, HoverTooltipButton } from "@/components/ui/tooltip";
import { useGitHubIssue } from "@/hooks/queries/useGitHubIssue";
import { useSavePinFiles } from "@/hooks/queries/usePins";
import { useSessionIssueRepos } from "@/hooks/queries/useSession";
import { useSelectSessionView } from "@/hooks/useSelectSessionView";
import { pinChatAt } from "@/lib/pins/chatTarget";
import {
  pinIssueRefs,
  type IssueRepoContext,
  type PinIssue,
} from "@/lib/pins/pinIssueRefs";
import {
  ISSUE_NUMBER_PROPERTY,
  ISSUE_REPO_PROPERTY,
  remarkIssueRefs,
} from "@/lib/pins/remarkIssueRefs";
import { stageSaved } from "@/lib/pins/staging";
import { encodeBase64 } from "@/lib/utils";

// #6453 (epic #6446): a pin's links (mockup v6 `detail()`, :703-718): the
// "Files:" line, the issues it names, Save to session folder, and In chat.

const ICON: CSSProperties = { width: "12px", height: "12px" };
const LINE_ICON: CSSProperties = { width: "13px", height: "13px" };
const BUTTON_STYLE: CSSProperties = { height: "26px", fontSize: "11.5px" };
const FILE_LINK_STYLE: CSSProperties = { color: "var(--view-accent-files)" };
const FILE_LINK_CLASS =
  "min-w-0 truncate font-mono underline decoration-dotted underline-offset-2";
/** The mockup's `.ilink`: link colour, semibold, dotted underline. */
const ISSUE_LINK_CLASS =
  "inline cursor-pointer border-0 border-b border-dotted bg-transparent p-0 font-semibold text-[var(--app-link)] hover:border-solid";
const ISSUE_LINK_STYLE: CSSProperties = {
  borderBottomColor: "color-mix(in srgb, var(--app-link) 60%, transparent)",
};
const FACTS_LINE_CLASS =
  "mt-1.5 flex min-w-0 items-center gap-1.5 text-[length:var(--text-body-dense)] text-[var(--app-hint)]";

/** The repositories a bare `#N` in this pin means (KD11). */
export function usePinIssueRepos(): IssueRepoContext {
  const { sessionId } = usePinsContext();
  return useSessionIssueRepos(sessionId);
}

/** `pin`'s own folder, relative to the session folder, without the trailing `/`. */
function folderOf(sessionId: string, key: string): string {
  return pinFolderPath(sessionId, key);
}

/** A folder link into the Files tab. */
function FolderLink(props: { path: string; label: string; tooltip: string }) {
  const { sessionId } = usePinsContext();
  return (
    <HoverTooltip content={props.tooltip}>
      <Link
        to="/sessions/$sessionId/files"
        params={{ sessionId }}
        search={{ dir: encodeBase64(trimTrailingSlashes(props.path)) }}
        className={FILE_LINK_CLASS}
        style={FILE_LINK_STYLE}
      >
        {props.label}
      </Link>
    </HoverTooltip>
  );
}

/**
 * "Files:" and the pin's folder in the Files tab (R9), then where it was saved.
 * The session level of the path is a 36-character id, so the label shortens it
 * and the tooltip names it in full. A pin whose agent kept its files under
 * `GeneratedFiles/pins/` itself shows that folder alone.
 */
export function PinFilesLine(props: { pin: Pin }) {
  const { pin } = props;
  const { sessionId } = usePinsContext();
  const sources = pinSaveSources(sessionId, pin.evidence ?? []);
  const hasSources = sources.folders.length > 0 || sources.files.length > 0;
  const savedTo = effectiveSavedTo(pin);
  if (!hasSources && !savedTo) return null;
  const folder = folderOf(sessionId, pin.key);
  return (
    <div className={FACTS_LINE_CLASS} data-testid="pin-files-line">
      <Folder style={LINE_ICON} className="shrink-0" aria-hidden />
      <span className="shrink-0">Files:</span>
      {hasSources ? (
        <FolderLink
          path={folder}
          label={`.hapi/pins/…/${pinFolderName(pin.key)}/`}
          tooltip={`Open in the Files tab: ${folder}/`}
        />
      ) : null}
      {hasSources && savedTo ? (
        <span className="shrink-0">· saved to</span>
      ) : null}
      {savedTo ? (
        <FolderLink
          path={savedTo}
          label={savedTo}
          tooltip={`Open in the Files tab: ${savedTo}`}
        />
      ) : null}
    </div>
  );
}

/**
 * One issue link (R10): a button styled like a link that opens the issue
 * viewer, which links on to GitHub. The tooltip names the issue once its
 * details are cached (the viewer fetched them), so hovering never fetches.
 */
export function PinIssueLink(props: {
  repo: string;
  number: number;
  children: React.ReactNode;
}) {
  const { api } = usePinsContext();
  const [open, setOpen] = useState(false);
  const [owner, name] = props.repo.split("/");
  const cached = useGitHubIssue(api, owner, name, props.number, {
    enabled: false,
  }).details;
  const tooltip = cached
    ? `#${props.number} · ${cached.state === "closed" ? "Closed" : "Open"} · ${cached.title} — open in the issue viewer`
    : `#${props.number} — open in the issue viewer`;
  return (
    <>
      <HoverTooltipButton
        type="button"
        content={tooltip}
        onClick={event => {
          event.stopPropagation();
          setOpen(true);
        }}
        className={ISSUE_LINK_CLASS}
        style={ISSUE_LINK_STYLE}
      >
        {props.children}
      </HoverTooltipButton>
      {open ? (
        <IssueInfoModal
          issue={{ repo: props.repo, number: props.number }}
          open
          onOpenChange={setOpen}
          api={api}
        />
      ) : null}
    </>
  );
}

/** "#12" in the session's own repository, else "owner/repo#12". */
function issueLabel(issue: PinIssue, repos: IssueRepoContext): string {
  const own = repos.repoIdentity?.toLowerCase();
  return own && issue.repo.toLowerCase() === own
    ? `#${issue.number}`
    : `${issue.repo}#${issue.number}`;
}

/** "Issues:" and every distinct issue the pin names anywhere (R10). */
export function PinIssuesLine(props: { pin: Pin }) {
  const repos = usePinIssueRepos();
  const issues = useMemo(
    () => pinIssueRefs(props.pin, repos),
    [props.pin, repos]
  );
  if (issues.length === 0) return null;
  return (
    <div
      className={`${FACTS_LINE_CLASS} flex-wrap`}
      data-testid="pin-issues-line"
    >
      <span className="shrink-0">Issues:</span>
      {issues.map(issue => (
        <PinIssueLink
          key={`${issue.repo}#${issue.number}`}
          repo={issue.repo}
          number={issue.number}
        >
          {issueLabel(issue, repos)}
        </PinIssueLink>
      ))}
    </div>
  );
}

/**
 * The context markdown's `a`: an issue reference the plugin made opens the
 * issue viewer; every other link renders as before.
 */
const PinMarkdownAnchor = memo(function PinMarkdownAnchor(
  props: ComponentPropsWithoutRef<"a">
) {
  const data = props as Record<string, unknown>;
  const repo = data[ISSUE_REPO_PROPERTY];
  const number = Number(data[ISSUE_NUMBER_PROPERTY]);
  if (typeof repo === "string" && Number.isInteger(number) && number > 0) {
    return (
      <PinIssueLink repo={repo} number={number}>
        {props.children}
      </PinIssueLink>
    );
  }
  return <InlineMarkdownAnchor {...props} />;
});

const PIN_MARKDOWN_COMPONENTS: Components = { a: PinMarkdownAnchor };

/**
 * The plugin list and components for a pin's context markdown (KD11). Both are
 * stable while the session's repositories are, so the memoized markdown does
 * not re-parse on every render.
 */
export function usePinMarkdownProps(): {
  remarkPlugins: NonNullable<Options["remarkPlugins"]>;
  components: Components;
} {
  const repos = usePinIssueRepos();
  const remarkPlugins = useMemo<NonNullable<Options["remarkPlugins"]>>(
    () => [
      [
        remarkIssueRefs,
        {
          resolveRepo: (ref: PinIssueRef) => resolveIssueRepo(ref, repos),
        },
      ],
    ],
    [repos]
  );
  return { remarkPlugins, components: PIN_MARKDOWN_COMPONENTS };
}

/** The server's reason for a refused Save, else the error's own message. */
function saveError(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body ?? "") as { error?: unknown };
      if (typeof body.error === "string" && body.error) return body.error;
    } catch {
      // Not JSON: fall through to the message.
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "The save failed";
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "Save to session folder" (R6, R7): copies the pin's files into
 * `GeneratedFiles/pins/<folder>/`. After a save it reads "Saved to session
 * folder", and "Save again" once the pin has a newer revision than the one
 * saved. Below 640 px it reads "Save" / "Saved" and the tooltip names the
 * folder, so the action row stays one line (PM ruling A2, Nov 8). A success
 * stages D's `saved` marker so this device's Submit is enabled; the server
 * reports the save on whichever device submits next.
 */
export function PinSaveButton(props: { pin: Pin }) {
  const { pin } = props;
  const { api, sessionId, via } = usePinsContext();
  const { showToast } = useToast();
  const save = useSavePinFiles(api, sessionId);
  const sources = pinSaveSources(sessionId, pin.evidence ?? []);
  if (sources.folders.length === 0 && sources.files.length === 0) return null;
  const folder = `GeneratedFiles/pins/${pinFolderName(pin.key)}/`;
  const savedRevision = pin.savedTo ? (pin.savedRevision ?? null) : null;
  const [label, phoneLabel] = save.isPending
    ? ["Saving…", "Saving…"]
    : savedRevision === null
      ? ["Save to session folder", "Save"]
      : pin.revision > savedRevision
        ? ["Save again", "Save again"]
        : ["Saved to session folder", "Saved"];
  return (
    <HoverTooltipButton
      type="button"
      content={`Copy this pin's files into ${folder} in this session's folder. Your next Submit tells the agent, which commits them.`}
      disabled={save.isPending}
      onClick={() =>
        save.mutate(pin.key, {
          onSuccess: res => {
            stageSaved(sessionId, pin, via);
            const notes = [plural(res.copied.length, "file")];
            if (res.kept.length > 0) {
              notes.push(
                `kept ${plural(res.kept.length, "newer copy", "newer copies")}`
              );
            }
            const skipped = res.skipped.length + (res.skippedMore ?? 0);
            if (skipped > 0) notes.push(`skipped ${skipped}`);
            showToast(`Saved to ${res.savedTo}: ${notes.join(", ")}`, {
              type: skipped > 0 ? "warning" : "success",
            });
          },
          onError: error =>
            showToast(`Not saved: ${saveError(error)}`, { type: "error" }),
        })
      }
      aria-label={label}
      className={PIN_ACTION_CLASS}
      style={BUTTON_STYLE}
    >
      <Save style={ICON} aria-hidden />
      <span className="max-sm:hidden">{label}</span>
      <span className="sm:hidden" aria-hidden>
        {phoneLabel}
      </span>
    </HoverTooltipButton>
  );
}

/**
 * "In chat" (R11): Chat, scrolled to where the pin was posted. Pins tab only,
 * because a chat card is already at that spot, and only when the pin knows
 * where (a fence's anchor or a tool post's seq). It switches the view the way a
 * View Picker tap does (`useSelectSessionView`), as I's "Go to chat" does. A square icon on a phone,
 * where the action row has no room for its label; the tooltip still names it.
 */
export function PinChatButton(props: { pin: Pin }) {
  const { pin } = props;
  const { api, sessionId, via } = usePinsContext();
  const selectView = useSelectSessionView(api, sessionId);
  const at = pinChatAt(pin);
  if (via !== "pins" || at === null) return null;
  return (
    <HoverTooltipButton
      type="button"
      content="Show where this was raised in the chat"
      aria-label="In chat"
      onClick={() => selectView("chat", at)}
      className={`${PIN_ACTION_CLASS} max-sm:px-1.5`}
      style={BUTTON_STYLE}
    >
      <MessageSquareText style={ICON} aria-hidden />
      <span className="max-sm:hidden">In chat</span>
    </HoverTooltipButton>
  );
}
