// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { useBackupIdentityStatus } from "@/hooks/queries/useBackupIdentityStatus";
import { useRevealBackupIdentity } from "@/hooks/mutations/useRevealBackupIdentity";
import { Button } from "@/components/ui/button";

/**
 * BackupKeySection — the "Backup Key" section of Settings → Preferences (issue
 * #2507, epic #2493; folded from the former `/settings/backup-key` page onto the
 * Keys page by the Settings sidebar reorganization, then onto Preferences by #4906).
 *
 * The user-facing half of the VM-born backup age identity custody model: the
 * authenticated user reveals the per-VM backup private key EXACTLY ONCE, saves
 * it, and acknowledges — after which the VM shreds it. This is the sole moment
 * the private key escapes the VM; the operator never sees or holds it.
 *
 * 🔴 The revealed identity is held in component state only (never the query
 * cache) and cleared on acknowledgement, so it does not linger in client memory.
 *
 * Full-width inside the drawer; does NOT attach its own useSwipeBack (SettingsDrawer
 * owns the single swipe-back handler). Mirrors `apiKeys.tsx` for layout + styling.
 */
export function BackupKeySection() {
  const { api } = useAppContext();

  const { data: status, isLoading } = useBackupIdentityStatus(api);
  const { reveal, acknowledge } = useRevealBackupIdentity(api);

  // The revealed identity lives in component state ONLY — never in the query
  // cache — and is cleared on acknowledgement (fire-once, delete-after-save).
  const [revealedIdentity, setRevealedIdentity] = useState<string | null>(null);
  const [savedChecked, setSavedChecked] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleReveal = () => {
    reveal.mutate(undefined, {
      onSuccess: data => setRevealedIdentity(data.identity),
    });
  };

  const handleCopy = async () => {
    if (!revealedIdentity) return;
    try {
      await navigator.clipboard.writeText(revealedIdentity);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / permissions) — the key is
      // still visible in the block below for manual selection.
      setCopied(false);
    }
  };

  const handleAcknowledge = () => {
    acknowledge.mutate(undefined, {
      // Clear the secret from component memory the moment the VM shreds it.
      onSuccess: () => {
        setRevealedIdentity(null);
        setSavedChecked(false);
        setCopied(false);
      },
    });
  };

  return (
    <div data-testid="backup-key-section">
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <h2 className="text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
            Backup encryption key
          </h2>
          <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
            This VM holds the private key that decrypts your encrypted backups.
            You can view it <strong>exactly once</strong>, here — after you save
            it and confirm, it is deleted from the VM and can never be shown
            again. Nobody else, including the operator, ever sees or keeps it.
          </p>

          {isLoading ? (
            <p className="text-[length:var(--text-label-strong)] text-[var(--app-hint)]">
              Loading…
            </p>
          ) : revealedIdentity ? (
            /* Reveal shown — force-acknowledge before it can be deleted. */
            <div
              className="flex flex-col gap-3 rounded-md border border-[var(--app-border)] p-3"
              data-testid="backup-key-reveal"
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
                  This is your <strong>only</strong> chance to save this key.
                  Store it somewhere safe (a password manager). Without it, your
                  backups cannot be recovered after this VM is lost.
                </p>
              </div>

              <pre
                className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                data-testid="backup-key-identity"
              >
                {revealedIdentity}
              </pre>

              <Button
                variant="outline"
                type="button"
                onClick={handleCopy}
                className="h-auto self-start px-3 py-1.5 text-[length:var(--text-body)] text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                data-testid="backup-key-copy"
              >
                {copied ? "Copied ✓" : "Copy to clipboard"}
              </Button>

              <label className="flex items-start gap-2 text-[length:var(--text-body)] text-[var(--app-fg)]">
                <input
                  type="checkbox"
                  checked={savedChecked}
                  onChange={e => setSavedChecked(e.target.checked)}
                  className="mt-0.5"
                  data-testid="backup-key-saved-checkbox"
                />
                <span>I have saved this key somewhere safe.</span>
              </label>

              <Button
                variant="accent"
                type="button"
                onClick={handleAcknowledge}
                disabled={!savedChecked || acknowledge.isPending}
                className="h-auto self-start px-4 py-2 text-[length:var(--text-label-strong)] text-[var(--app-bg)]"
                data-testid="backup-key-done"
              >
                {acknowledge.isPending
                  ? "Finishing…"
                  : "Done — delete it from the VM"}
              </Button>
              {acknowledge.isError && (
                <p
                  className="text-[length:var(--text-body)]"
                  style={{ color: "var(--status-hot)" }}
                >
                  Could not finish. Your key was NOT deleted — try again.
                </p>
              )}
            </div>
          ) : status?.present ? (
            /* An unrevealed identity is pending — offer the one-time reveal. */
            <div
              className="flex flex-col gap-2"
              data-testid="backup-key-pending"
            >
              <Button
                variant="accent"
                type="button"
                onClick={handleReveal}
                disabled={reveal.isPending}
                className="h-auto self-start px-4 py-2 text-[length:var(--text-label-strong)] text-[var(--app-bg)]"
                data-testid="backup-key-reveal-button"
              >
                {reveal.isPending ? "Revealing…" : "Reveal my backup key"}
              </Button>
              {reveal.isError && (
                <p
                  className="text-[length:var(--text-body)]"
                  style={{ color: "var(--status-hot)" }}
                  data-testid="backup-key-reveal-error"
                >
                  Could not reveal the key — it may already have been revealed.
                  Reload this page to refresh its status.
                </p>
              )}
            </div>
          ) : status?.revealed ? (
            /* Already revealed + acknowledged — the key is gone from the VM. */
            <div
              className="flex flex-col items-center gap-2 rounded-md border border-dashed border-[var(--app-border)] px-4 py-8 text-center"
              data-testid="backup-key-revealed"
            >
              <KeyRound className="h-6 w-6 text-[var(--app-hint)]" />
              <p className="text-[length:var(--text-label-strong)] text-[var(--app-fg)]">
                Your backup key has been saved
              </p>
              <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
                It is no longer retrievable from this VM. Keep the copy you
                saved — it is the only way to decrypt your backups.
              </p>
              {status.recipient && (
                <p className="mt-1 break-all text-[length:var(--text-caption)] text-[var(--app-hint)]">
                  Public recipient: <code>{status.recipient}</code>
                </p>
              )}
            </div>
          ) : (
            /* Nothing generated yet on this VM. */
            <div
              className="flex flex-col items-center gap-2 rounded-md border border-dashed border-[var(--app-border)] px-4 py-8 text-center"
              data-testid="backup-key-none"
            >
              <KeyRound className="h-6 w-6 text-[var(--app-hint)]" />
              <p className="text-[length:var(--text-label-strong)] text-[var(--app-fg)]">
                No backup key on this VM yet
              </p>
              <p className="text-[length:var(--text-body)] text-[var(--app-hint)]">
                A backup key is generated during provisioning. If you just
                provisioned this instance, reload in a moment.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
