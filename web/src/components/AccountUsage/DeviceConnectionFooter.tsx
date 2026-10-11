// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";
import { useAppContext } from "@/lib/app-context";
import { useServerUrl } from "@/hooks/useServerUrl";
import { useAuthSource } from "@/hooks/useAuthSource";

type InfoRowProps = {
  label: string;
  value: ReactNode;
  testId?: string;
};

function InfoRow({ label, value, testId }: InfoRowProps) {
  return (
    <div
      className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3"
      data-testid={testId}
    >
      <span className="text-[length:var(--text-body)] uppercase tracking-wide text-[var(--app-hint)]">
        {label}
      </span>
      <span
        className="ml-3 text-right text-[15px] text-[var(--app-fg)]" /* design-tokens-allow: 15px value text — no --text token (ladder is 10-14px) or Tailwind utility (text-sm=14/text-base=16) maps to 15px (L3 #3405) */
      >
        {value}
      </span>
    </div>
  );
}

function displayName(
  user:
    | { username?: string; firstName?: string; lastName?: string; id: number }
    | null
    | undefined
): string {
  if (!user) return "(not signed in)";
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (user.username) return user.username;
  return `User #${user.id}`;
}

/**
 * DeviceConnectionFooter — the "This device & connection" footer for the
 * `/account-usage` page (epic #1855, Sub G / #1862).
 *
 * Absorbs the four identity fields that used to live on the standalone Profile page
 * (`web/src/routes/settings/profile.tsx`, removed in #1862): the Hapimatic client display
 * name, the auth source, and the server/base URL. It is self-contained — it reads
 * `useAppContext().user`, `useServerUrl()`, and `useAuthSource()` itself, mirroring how
 * the Profile page sourced them.
 *
 * 🔴 Disambiguation (the load-bearing requirement of #1862): the Account Usage page is a
 * list of *Anthropic* account-usage cards, so this footer MUST read as the **Hapimatic
 * client / device identity, NOT a Claude account**. The section heading + the caption
 * carry that framing. The Profile page's Sign Out button is intentionally NOT moved here —
 * Sign Out remains the standalone top-level drawer row in `ADMIN_SECTIONS`.
 */
export function DeviceConnectionFooter() {
  const { user } = useAppContext();
  const { serverUrl, baseUrl } = useServerUrl();
  const { isTelegram } = useAuthSource(baseUrl);

  const authSourceText = isTelegram
    ? "Telegram Mini App"
    : "Browser access token";

  return (
    <section
      className="mt-6 border-t border-[var(--app-border)] pt-2"
      data-testid="device-connection-footer"
    >
      <h2 className="px-4 py-2 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-[var(--app-hint)]">
        This device &amp; connection
      </h2>
      <p className="px-4 pb-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        Your Hapimatic client login and server — not a Claude account.
      </p>

      <InfoRow
        label="Signed in as"
        value={displayName(user)}
        testId="profile-row-display-name"
      />
      <InfoRow
        label="Auth Source"
        value={authSourceText}
        testId="profile-row-auth-source"
      />
      <InfoRow
        label="Server URL"
        value={serverUrl ?? "(current origin)"}
        testId="profile-row-server-url"
      />
      <InfoRow label="Base URL" value={baseUrl} testId="profile-row-base-url" />
    </section>
  );
}
