// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Waypoints } from "lucide-react";
import { ApiError } from "@/api/client";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useTailscaleStatus } from "@/hooks/queries/useTailscaleStatus";
import { useAppContext } from "@/lib/app-context";
import { queryKeys } from "@/lib/query-keys";

const ACCENT = "var(--accent-sky-400)";
const KEYS_URL = "https://login.tailscale.com/admin/settings/keys";

/** The body's human `error`, not the transport string. */
function joinErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.body) {
    try {
      const parsed = JSON.parse(err.body) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // Non-JSON body: fall through to the plain line.
    }
  }
  return "The join did not finish. Check your connection, then try again.";
}

/**
 * NetworkPage — the `/settings/network` route (#6211 R23): join this VM to the
 * user's tailnet from inside the instance. The auth key is held only in this
 * form's state until it is posted, then cleared, and the server keeps it only in a
 * file it removes after the join.
 *
 * Registered in BOTH `router.tsx` (route) and `settings/index.tsx` (menu row), so
 * it is not an invisible page (#2344).
 */
export default function NetworkPage() {
  useDocumentTitle("Network - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const status = useTailscaleStatus(api);
  const [authKey, setAuthKey] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<unknown>(null);

  // Not a mutation: its cache would keep the key in `variables` after this clears it.
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = authKey.trim();
    if (!key || joining) return;
    setAuthKey("");
    setJoining(true);
    setJoinError(null);
    try {
      if (!api) throw new Error("API unavailable");
      await api.joinTailscale(key);
    } catch (err) {
      setJoinError(err);
    } finally {
      setJoining(false);
    }
    // A join that timed out can still finish, so a failure reads the status too.
    await queryClient.invalidateQueries({
      queryKey: queryKeys.tailscaleStatus,
    });
  };

  const data = status.data;

  return (
    <SettingsPage
      data-testid="settings-network-root"
      header={
        <SettingsSectionHeader
          icon={<TitleChip icon={Waypoints} accent={ACCENT} />}
          title="Network"
        />
      }
    >
      <div className="mx-auto flex w-full max-w-content flex-col gap-5 p-4 text-sm text-[var(--app-fg)]">
        <p className="text-[var(--app-hint)]">
          Tailscale is optional. It puts this VM on a private network with your
          own devices.
        </p>

        {status.isPending && api ? (
          <p className="text-[var(--app-hint)]">Loading…</p>
        ) : status.isError || !data ? (
          <p role="status" className="text-[var(--status-warn)]">
            Network status could not be loaded. Check your connection, then
            reload the page.
          </p>
        ) : data.state === "joined" ? (
          <p
            role="status"
            className="text-[var(--status-ok)]"
            data-testid="tailscale-joined"
          >
            ✓ This VM is on your tailnet
            {data.hostname ? ` as ${data.hostname}` : ""}
            {data.ip ? ` (${data.ip})` : ""}.
          </p>
        ) : data.state === "unavailable" ? (
          <p role="status" className="text-[var(--app-hint)]">
            Tailscale is not available on this install.
          </p>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={e => void submit(e)}>
            <ol className="list-decimal space-y-2 pl-5 text-[var(--app-hint)]">
              <li>
                Open{" "}
                <a
                  href={KEYS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--app-link)] underline"
                >
                  your Tailscale keys page
                </a>{" "}
                and click Generate auth key. Leave Reusable off, because a
                single-use key is safest.
              </li>
              <li>
                For the description, use{" "}
                <code className="text-[var(--app-fg)]">{data.deviceName}</code>.
                Letters, numbers and dashes only.
              </li>
              <li>
                Copy the <code>tskey-auth-…</code> value, which is shown only
                once, and paste it below.
              </li>
            </ol>
            <div className="flex flex-col gap-1">
              <label htmlFor="tailscale-auth-key" className="font-medium">
                Tailscale auth key
              </label>
              <input
                id="tailscale-auth-key"
                data-guide="tailscale-key"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={authKey}
                disabled={joining}
                onChange={e => setAuthKey(e.target.value)}
                placeholder="tskey-auth-…"
                className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-[var(--app-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                style={{ fontSize: "16px" }}
              />
              <p className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
                The key stays on this VM and is deleted as soon as the join
                finishes.
              </p>
            </div>
            <Button
              type="submit"
              className="self-start"
              disabled={!authKey.trim() || joining}
              data-testid="tailscale-join"
            >
              {joining ? "Joining…" : "Add this VM to my tailnet"}
            </Button>
            {joinError !== null && (
              <div
                role="alert"
                className="rounded-md bg-red-900/20 p-2 text-red-400"
                data-testid="tailscale-join-error"
              >
                {joinErrorMessage(joinError)}
              </div>
            )}
          </form>
        )}

        <details className="text-[var(--app-hint)]">
          <summary className="cursor-pointer">Learn more</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p>
              Tailscale is a free private network between your own devices.
              Adding this VM lets your PC, your phone and a Hapimatic node on
              your own hardware all reach it securely. It is the foundation for
              federation and for mounting the VM&apos;s files.
            </p>
            <p>
              Why does the key expire? It is used once, to join, and is never
              needed again, which is why Tailscale caps auth keys at 90 days.
              The VM&apos;s tailnet membership does not expire with the key. To
              keep the machine from ever needing to sign in again, disable key
              expiry for it in the Tailscale admin console (Machines → ⋯ →
              Disable key expiry), or generate the auth key with a tag, because
              tagged devices do not expire.
            </p>
          </div>
        </details>
      </div>
    </SettingsPage>
  );
}
