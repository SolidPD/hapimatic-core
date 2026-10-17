// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { LifeBuoy } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import { useSupportChannel } from "@/hooks/queries/useSupportChannel";
import { useSessions } from "@/hooks/queries/useSessions";
import { requestOpenOnboarding } from "@/hooks/useOnboardingState";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { HelpMenu, type SupportAgent } from "@/components/HelpMenu";
import { SupportEscalationModal } from "@/components/SupportEscalationModal";
import { ApiError } from "@/api/client";

export const HELP_ACCENT = "var(--accent-sky-400)";

/**
 * AdminHelpPage — the `/settings/help` route (issue #4371, E6 Sub F).
 *
 * Reached from the Help row in the Settings menu and the Help link in the
 * footer (operator ruling 4371-D1 = C). Three actions, self-help first (R5):
 * ask the in-app support assistant (opens — or reuses — the support session),
 * replay the first-run tour, and contact a human. Contact a human escalates
 * from the user's active support session when there is one; without one it
 * steers to the assistant first, and with no channel configured it shows the
 * open-an-issue link (R6).
 */
export default function AdminHelpPage() {
  useDocumentTitle("Help - Hapimatic");
  useEmojiFavicon(null);
  const { api, user } = useAppContext();
  const navigate = useNavigate();
  const { channel, isError: channelError } = useSupportChannel(api);
  const { sessions } = useSessions(api);

  const [agent, setAgent] = useState<SupportAgent>("claude");
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);

  const supportSessionId =
    (channel &&
      sessions.find(s => s.active && s.metadata?.path === channel.workspacePath)
        ?.id) ??
    null;

  const askAssistant = async () => {
    if (!api) return;
    setOpening(true);
    setOpenError(null);
    try {
      const { sessionId } = await api.openSupportSession(agent);
      setContactOpen(false);
      await navigate({ to: "/sessions/$sessionId", params: { sessionId } });
    } catch (err) {
      setOpenError(
        err instanceof ApiError && err.code === "no_local_machine"
          ? "The assistant needs this server's own machine to be online. Check the machine list, then try again."
          : "Could not open the assistant. Try again in a moment."
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <div
      data-testid="settings-help-root"
      className="flex h-full flex-col overflow-y-auto"
    >
      <SettingsSectionHeader
        icon={<TitleChip icon={LifeBuoy} accent={HELP_ACCENT} />}
        title="Help"
      />

      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col gap-4 px-4 pb-4">
        <p className="text-sm text-[var(--app-hint)]">
          Start with the assistant: it knows the Hapimatic guide and can check
          your install. A person is the next step if you need one.
        </p>
        <HelpMenu
          agent={agent}
          onAgentChange={setAgent}
          onAskAssistant={() => void askAssistant()}
          onReplayTour={requestOpenOnboarding}
          onContactHuman={() => setContactOpen(true)}
          opening={opening}
          openError={openError}
        />
        {channel?.hoursText ? (
          <p
            data-testid="help-hours-text"
            className="text-sm text-[var(--app-hint)]"
          >
            {channel.hoursText}
          </p>
        ) : null}
      </div>

      {api ? (
        <SupportEscalationModal
          open={contactOpen}
          onClose={() => setContactOpen(false)}
          api={api}
          channel={channel}
          channelError={channelError}
          sessionId={supportSessionId}
          onAskAssistant={() => void askAssistant()}
          replyEmail={user?.username ?? null}
        />
      ) : null}
    </div>
  );
}
