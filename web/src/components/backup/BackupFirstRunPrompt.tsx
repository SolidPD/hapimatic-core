// SPDX-License-Identifier: AGPL-3.0-only
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { KeyRound, ShieldAlert } from "lucide-react";
import type { BackupPromptPreference } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { DialogForm } from "@/components/layouts/DialogForm";
import { useToast } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useRevealBackupIdentity } from "@/hooks/mutations/useRevealBackupIdentity";
import {
  isBackupProvisioned,
  useBackupIdentityStatus,
} from "@/hooks/queries/useBackupIdentityStatus";
import {
  BACKUP_PROMPT_CLOSE_EVENT,
  BACKUP_PROMPT_OPEN_EVENT,
  ONBOARDING_OPEN_EVENT,
} from "@/hooks/useOnboardingState";
import { useAppContext } from "@/lib/app-context";
import { queryKeys } from "@/lib/query-keys";
import type { BackupIdentityStatus } from "@/types/backupIdentity";
import {
  BACKUP_KEY_FILE_NOTE,
  BACKUP_NO_KEY_COPY,
  BACKUP_PASSPHRASE_URL,
  BACKUP_POLICY_DOCS_URL,
  BACKUP_POLICY_LABELS,
  BACKUP_POLICY_LINES,
  BACKUP_POLICY_SUMMARY,
  BACKUP_SKIP_LINE,
} from "./backupPolicyCopy";

/** Which version of the step an instance gets, or none. */
export type BackupPromptVariant = "save-key" | "no-key";

/**
 * The presentation rule (#4791 R1, R5), pure so it can be tested on its own:
 * - a pending per-VM key (`present`, not `revealed`) → the save-key step;
 * - no pending key, not revealed, but a recipient (a Model C VM, or a Model A
 *   VM whose pending key file vanished — the status cannot tell them apart) →
 *   the informational no-key step;
 * - not backup-provisioned, already saved, or skipped → nothing.
 */
export function backupPromptVariant(
  status: BackupIdentityStatus | undefined,
  skipped: boolean
): BackupPromptVariant | null {
  if (skipped || !status || !isBackupProvisioned(status)) return null;
  if (status.revealed) return null;
  if (status.present) return "save-key";
  return status.recipient !== null ? "no-key" : null;
}

/**
 * What the onboarding-tour read says for the gate (#4791 R8, LC6). `unknown` is
 * a failed read: it counts as not pending only while this app load has never
 * seen the tour pending, so a blip in the 2 s poll while the tour is open never
 * reads as the tour having closed.
 */
type OnboardingGate = "pending" | "clear" | "unknown";

/**
 * At most one presentation per app load (#4791 R1): module state, because a
 * remount of the host in the same load must not present again.
 */
let presentedThisLoad = false;

/** Test-only: forget that the step was presented in this app load. */
export function __resetBackupFirstRunPromptForTests(): void {
  presentedThisLoad = false;
}

const ONBOARDING_PENDING_POLL_MS = 2000;
const SKIP_TOAST_MS = 8000;

/**
 * The first-run backup step (#4791): ONE app-level host, mounted in `App.tsx`
 * beside #3865's `OnboardingHost`, that asks the user to save this instance's
 * backup key once it is running. It runs in the instance, not the gateway
 * wizard (ruling D-4791-2 = Option 1): the key goes from the user's own VM to
 * the browser and nowhere else — the step calls only this instance's
 * `/api/backup/identity/*` and `/api/preferences/*` routes (R6).
 *
 * Presents when ALL hold: the pathname is exactly `/sessions` with no `drawer`
 * search param; the backup status, the skip marker and the onboarding-tour state
 * are loaded; {@link backupPromptVariant} picks a variant; the tour is not
 * pending; and the step has not been presented in this app load. Every read is
 * enabled only on `/sessions`, so the app-level observers idle on other routes.
 *
 * LC6 with #3865's tour (epic #4789, operator-confirmed 2026-10-08): the step
 * waits while the tour reads `pending` (re-reading every 2 s so it opens once
 * the tour closes; a failed read counts as not pending until the tour has been
 * seen pending, and after that only a successful read releases it); it dispatches
 * `hapi:backup-prompt-open` / `hapi:backup-prompt-close`, which the tour honours;
 * and on `hapi:onboarding-open` it closes WITHOUT acknowledging and without the
 * skip marker. If the tour opens before the step does, the step holds until the
 * tour's state goes from pending to done, so the two never stack.
 */
export function BackupFirstRunPrompt() {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const pathname = useLocation({ select: location => location.pathname });
  const hasDrawerParam = useLocation({
    select: location =>
      (location.search as { drawer?: unknown } | undefined)?.drawer !==
      undefined,
  });
  const onSessions = pathname === "/sessions";

  const status = useBackupIdentityStatus(api, { enabled: onSessions });
  const preference = useQuery<BackupPromptPreference>({
    queryKey: queryKeys.backupPromptPreference,
    queryFn: () => {
      if (!api) throw new Error("No API client");
      return api.getBackupPromptPreference();
    },
    enabled: onSessions && Boolean(api),
    retry: false,
  });
  // Whether this app load has seen the tour pending (state for the render,
  // ref for the onboarding query's refetchInterval callback).
  const [sawPending, setSawPending] = useState(false);
  const sawPendingRef = useRef(false);
  const onboarding = useQuery<OnboardingGate>({
    queryKey: queryKeys.backupPromptOnboardingGate,
    queryFn: async () => {
      // Feature-detected (LC6): no method means no tour. A failed read (a 404
      // included) is `unknown`, which the gate below treats as not pending
      // until the tour has been seen pending in this app load.
      if (!api || typeof api.getOnboardingState !== "function") return "clear";
      try {
        const state = await api.getOnboardingState();
        return state.status === "pending" ? "pending" : "clear";
      } catch {
        return "unknown";
      }
    },
    enabled: onSessions && Boolean(api),
    retry: false,
    // Keep polling through a failed read once the tour was seen pending, so
    // the step still opens when the tour closes.
    refetchInterval: query =>
      query.state.data === "pending" ||
      (query.state.data === "unknown" && sawPendingRef.current)
        ? ONBOARDING_PENDING_POLL_MS
        : false,
  });

  const [open, setOpen] = useState<BackupPromptVariant | null>(null);
  const openRef = useRef<BackupPromptVariant | null>(null);
  // Set when the tour opens while the step is not on screen. Released only by
  // a successful `clear` read after the tour was seen pending, the one sign that
  // the tour has closed: a Settings re-entry (never pending in this load) or a
  // failed read never shows it, so the step then waits for the next app load
  // instead of stacking a second modal over the tour.
  const [heldByTour, setHeldByTour] = useState(false);

  const close = useCallback(() => {
    openRef.current = null;
    setOpen(null);
    window.dispatchEvent(new CustomEvent(BACKUP_PROMPT_CLOSE_EVENT));
  }, []);

  useEffect(() => {
    const onTourOpen = () => {
      if (openRef.current) {
        close();
      } else {
        setHeldByTour(true);
      }
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, onTourOpen);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, onTourOpen);
  }, [close]);

  useEffect(() => {
    if (onboarding.data === "pending") {
      sawPendingRef.current = true;
      setSawPending(true);
    } else if (onboarding.data === "clear" && sawPendingRef.current) {
      setHeldByTour(false);
    }
  }, [onboarding.data]);

  const variant =
    status.isSuccess && preference.isSuccess
      ? backupPromptVariant(status.data, preference.data.skipped)
      : null;
  const gateClear =
    onboarding.data === "clear" ||
    (onboarding.data === "unknown" && !sawPending);
  const tourClear = onboarding.isSuccess && gateClear && !heldByTour;

  useEffect(() => {
    if (openRef.current || presentedThisLoad) return;
    if (!onSessions || hasDrawerParam || !tourClear || !variant) return;
    presentedThisLoad = true;
    openRef.current = variant;
    setOpen(variant);
    window.dispatchEvent(new CustomEvent(BACKUP_PROMPT_OPEN_EVENT));
  }, [onSessions, hasDrawerParam, tourClear, variant]);

  const recordSkip = useMutation({
    mutationFn: async () => {
      if (!api) throw new Error("No API client");
      return await api.setBackupPromptPreference({ skipped: true });
    },
    onMutate: () => {
      queryClient.setQueryData<BackupPromptPreference>(
        queryKeys.backupPromptPreference,
        { skipped: true }
      );
    },
    onError: () => {
      showToast(
        "Couldn't record that you skipped this step; it may appear again next time.",
        { type: "error" }
      );
    },
  });

  if (!open) return null;

  return (
    <BackupKeyDialog
      variant={open}
      api={api}
      onDone={close}
      onSkip={() => {
        recordSkip.mutate();
        if (open === "save-key") {
          // Twice the info default: the line carries a three-step Settings path.
          showToast(BACKUP_SKIP_LINE, {
            type: "info",
            duration: SKIP_TOAST_MS,
          });
        }
        close();
      }}
    />
  );
}

interface BackupKeyDialogProps {
  variant: BackupPromptVariant;
  api: ApiClient | null;
  /** The key was saved and acknowledged (the VM has shredded its copy). */
  onDone: () => void;
  /** Skip for now, Continue (no-key variant), Escape, the ✕ or a backdrop click. */
  onSkip: () => void;
}

/**
 * `hapimatic-backup-key-<hostname>.txt`, the hostname cut to `[a-z0-9.-]` (the
 * app has no subdomain API, so a worktree instance yields `localhost` or an IP).
 * Edge dashes are trimmed by index, not a trailing `-+$`, which is quadratic.
 */
export function keyFileName(hostname = window.location.hostname): string {
  const host = hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  let start = 0;
  let end = host.length;
  while (start < end && host[start] === "-") start++;
  while (end > start && host[end - 1] === "-") end--;
  return `hapimatic-backup-key-${host.slice(start, end) || "instance"}.txt`;
}

function isStandaloneWebApp(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** How a Save file attempt ended. */
type SaveKeyFileResult = "saved" | "cancelled" | "share-failed";

/**
 * Save the identity as a text file. An installed iOS web app cannot follow a
 * `download` link (it fails silently or traps the app), so there the file goes
 * through the share sheet; everywhere else, and when the share sheet cannot take
 * a file at all, a Blob link downloads it. A share sheet that fails for any
 * reason other than the user closing it reports `share-failed` rather than
 * falling back to that download link.
 */
async function saveKeyFile(identity: string): Promise<SaveKeyFileResult> {
  const name = keyFileName();
  if (isStandaloneWebApp() && typeof navigator.share === "function") {
    const file = new File([identity], name, { type: "text/plain" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "saved";
      } catch (error) {
        // The user closed the share sheet: nothing to report.
        if (error instanceof DOMException && error.name === "AbortError") {
          return "cancelled";
        }
        return "share-failed";
      }
    }
  }
  const url = URL.createObjectURL(new Blob([identity], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return "saved";
}

/**
 * The dialog, in #4790's region order built from the app's own components (R7):
 * graphic, heading and a short lead, the area, Learn more, and a button row with
 * the primary on the right. It owns the reveal hook, so it unmounts on every
 * close and the reveal mutation detaches with it; the handlers also call
 * `reveal.reset()` and clear the identity, and the hook's `gcTime: 0` then evicts
 * it from TanStack's MutationCache (R9). The identity is never logged.
 */
function BackupKeyDialog({
  variant,
  api,
  onDone,
  onSkip,
}: BackupKeyDialogProps) {
  const { reveal, acknowledge } = useRevealBackupIdentity(api);
  const [identity, setIdentity] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareFailed, setShareFailed] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const revealRef = useRef<HTMLButtonElement>(null);
  const saveKey = variant === "save-key";

  const forget = () => {
    setIdentity(null);
    setSaved(false);
    setCopied(false);
    setShareFailed(false);
    reveal.reset();
  };

  const handleSaveFile = async () => {
    if (!identity) return;
    setShareFailed((await saveKeyFile(identity)) === "share-failed");
  };

  const skip = () => {
    if (acknowledge.isPending) return;
    forget();
    onSkip();
  };

  const handleReveal = () => {
    reveal.mutate(undefined, {
      onSuccess: data => setIdentity(data.identity),
    });
  };

  const handleCopy = async () => {
    if (!identity) return;
    try {
      await navigator.clipboard.writeText(identity);
      setCopied(true);
    } catch {
      // No clipboard (insecure context or permissions): the key stays visible
      // for manual selection, and Save file still works.
      setCopied(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!saveKey) {
      onSkip();
      return;
    }
    if (!identity || !saved || acknowledge.isPending) return;
    acknowledge.mutate(undefined, {
      onSuccess: () => {
        forget();
        onDone();
      },
      // On failure the dialog stays open with the key still visible (R3).
    });
  };

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) skip();
      }}
    >
      <DialogContent
        heightVariant="threeQuarter"
        className="flex flex-col"
        data-testid="backup-prompt"
        data-variant={variant}
        description={
          saveKey
            ? "Save this instance's backup key, or skip and save it later in Settings."
            : "This instance has no backup key to save."
        }
        onOpenAutoFocus={event => {
          // Done starts disabled in the save-key step and a disabled button
          // takes no focus, so focus Reveal key there.
          event.preventDefault();
          (saveKey ? revealRef : primaryRef).current?.focus();
        }}
      >
        <DialogForm
          className="h-full"
          onSubmit={handleSubmit}
          title={
            <div className="flex flex-col items-start gap-3 pb-3 pr-8">
              <span
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--app-accent)] text-[var(--app-accent)]"
              >
                <KeyRound className="h-5 w-5" strokeWidth={1.75} />
              </span>
              <DialogTitle className="text-[length:var(--text-label-strong)] font-semibold leading-snug tracking-normal text-[var(--app-fg)]">
                {saveKey ? "Save your backup key" : BACKUP_NO_KEY_COPY.heading}
              </DialogTitle>
              <p className="text-[length:var(--text-body)] leading-relaxed text-[var(--app-hint)]">
                {saveKey
                  ? "Your nightly backups are encrypted with a key only you keep. Save it now: without it, nobody can restore them."
                  : BACKUP_NO_KEY_COPY.lead}
              </p>
            </div>
          }
          footer={
            <div className="flex flex-col gap-3 border-t border-[var(--app-border)] pt-3">
              {saveKey && (
                <p
                  className="text-[length:var(--text-caption)] text-[var(--app-hint)]"
                  data-testid="backup-prompt-skip-line"
                >
                  {BACKUP_SKIP_LINE}
                </p>
              )}
              <div
                className={`flex items-center gap-3 ${saveKey ? "justify-between" : "justify-end"}`}
              >
                {saveKey && (
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid="backup-prompt-skip"
                    onClick={skip}
                    disabled={acknowledge.isPending}
                  >
                    Skip for now
                  </Button>
                )}
                <Button
                  ref={primaryRef}
                  type="submit"
                  size="lg"
                  data-testid="backup-prompt-primary"
                  disabled={
                    saveKey && (!identity || !saved || acknowledge.isPending)
                  }
                >
                  {!saveKey
                    ? "Continue"
                    : acknowledge.isPending
                      ? "Finishing…"
                      : "Done"}
                </Button>
              </div>
            </div>
          }
        >
          <div className="flex flex-col gap-4 py-2">
            {saveKey ? (
              <>
                <p className="text-[length:var(--text-body)] leading-relaxed text-[var(--app-fg)]">
                  {BACKUP_POLICY_SUMMARY}
                </p>
                {identity ? (
                  <div
                    className="flex flex-col gap-3"
                    data-testid="backup-prompt-reveal"
                  >
                    <div
                      className="flex items-start gap-2 rounded-md px-3 py-2"
                      style={{
                        backgroundColor: "rgba(251, 191, 36, 0.12)",
                        color: "var(--status-warn)",
                      }}
                    >
                      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      <p className="text-[length:var(--text-body)]">
                        Once you tap Done, this instance deletes its copy. Keep
                        yours somewhere safe, such as a password manager.
                      </p>
                    </div>
                    <pre
                      className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                      data-testid="backup-prompt-identity"
                    >
                      {identity}
                    </pre>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="accent"
                        onClick={handleCopy}
                        className="text-[var(--app-bg)]"
                        data-testid="backup-prompt-copy"
                      >
                        {copied ? "Copied ✓" : "Copy"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void handleSaveFile()}
                        data-testid="backup-prompt-save-file"
                      >
                        Save file
                      </Button>
                    </div>
                    {shareFailed && (
                      <p
                        className="text-[length:var(--text-body)]"
                        style={{ color: "var(--status-hot)" }}
                        data-testid="backup-prompt-share-error"
                      >
                        Couldn't open the share sheet. Use Copy instead, or try
                        Save file again.
                      </p>
                    )}
                    <label className="flex items-start gap-2 text-[length:var(--text-body)] text-[var(--app-fg)]">
                      <input
                        type="checkbox"
                        checked={saved}
                        onChange={e => setSaved(e.target.checked)}
                        className="mt-0.5"
                        data-testid="backup-prompt-saved-checkbox"
                      />
                      <span>I've saved my key somewhere safe.</span>
                    </label>
                    {acknowledge.isError && (
                      <p
                        className="text-[length:var(--text-body)]"
                        style={{ color: "var(--status-hot)" }}
                        data-testid="backup-prompt-ack-error"
                      >
                        Could not confirm that this instance deleted its copy.
                        Keep your saved copy, then try again.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Button
                      ref={revealRef}
                      type="button"
                      variant="outline"
                      onClick={handleReveal}
                      disabled={reveal.isPending}
                      className="self-start"
                      data-testid="backup-prompt-reveal-button"
                    >
                      {reveal.isPending ? "Revealing…" : "Reveal key"}
                    </Button>
                    {reveal.isError && (
                      <p
                        className="text-[length:var(--text-body)]"
                        style={{ color: "var(--status-hot)" }}
                        data-testid="backup-prompt-reveal-error"
                      >
                        Could not reveal the key. It may already have been saved
                        in Settings; reload to refresh.
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-[length:var(--text-body)] leading-relaxed text-[var(--app-fg)]">
                  {BACKUP_NO_KEY_COPY.noRecovery}
                </p>
                <a
                  href={BACKUP_PASSPHRASE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="self-start text-[length:var(--text-body)] text-[var(--app-accent)] underline"
                  data-testid="backup-prompt-passphrase-link"
                >
                  {BACKUP_NO_KEY_COPY.link}
                </a>
              </>
            )}
            <details
              className="text-[length:var(--text-body)] text-[var(--app-fg)]"
              data-testid="backup-prompt-learn-more"
            >
              <summary className="cursor-pointer text-[var(--app-hint)]">
                Learn more
              </summary>
              <dl className="mt-2 flex flex-col gap-2">
                {(
                  Object.keys(BACKUP_POLICY_LINES) as Array<
                    keyof typeof BACKUP_POLICY_LINES
                  >
                )
                  .filter(key => saveKey || key !== "loss")
                  .map(key => (
                    <div key={key}>
                      <dt className="font-medium">
                        {BACKUP_POLICY_LABELS[key]}
                      </dt>
                      <dd className="text-[var(--app-hint)]">
                        {BACKUP_POLICY_LINES[key]}
                      </dd>
                    </div>
                  ))}
              </dl>
              {saveKey && (
                <p className="mt-2 text-[var(--app-hint)]">
                  {BACKUP_KEY_FILE_NOTE}
                </p>
              )}
              <a
                href={BACKUP_POLICY_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-[var(--app-accent)] underline"
              >
                Backups in the FAQ
              </a>
            </details>
          </div>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
