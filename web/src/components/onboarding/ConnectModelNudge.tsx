// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ApiClient } from "@/api/client";
import type { AgentType } from "@/components/NewSession/types";
import { StatePanel } from "@/components/ui/StatePanel";
import { Button } from "@/components/ui/button";
import {
  startProvider,
  useModelConnection,
} from "@/hooks/queries/useModelConnection";
import { useOnboardingGuideOpen } from "@/hooks/useOnboardingState";

/** Provider Accounts is where a model gets connected, from every surface here (R13). */
const PROVIDER_ACCOUNTS_ROUTE = "/settings/account-usage";

// In memory, so it lasts this app load and a reload brings the nudge back. sessionStorage
// would outlive a reload, and a long-lived tab would never see it again.
let dismissedThisLoad = false;

/** Test seam: a new app load starts with this cleared. */
export function __resetConnectModelNudgeForTests(): void {
  dismissedThisLoad = false;
}

function ConnectModelButton(props: { variant?: "default" | "outline" }) {
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      size="sm"
      variant={props.variant ?? "default"}
      data-testid="connect-model-button"
      onClick={() => void navigate({ to: PROVIDER_ACCOUNTS_ROUTE })}
    >
      Connect a model
    </Button>
  );
}

/**
 * #6211 R13: the reminder for someone who skipped connecting a model. Only on an
 * answered `none`, because an `unknown` must never show a nudge. It returns on the
 * next app load until a provider is connected; a dismissal lasts for this one. It
 * stays out of the way while the wizard is on screen, which is already saying so.
 */
export function ConnectModelNudge({ api }: { api: ApiClient | null }) {
  const connection = useModelConnection(api);
  const guideOpen = useOnboardingGuideOpen();
  const [dismissed, setDismissed] = useState(dismissedThisLoad);

  if (connection.status !== "none" || dismissed || guideOpen) return null;

  return (
    <div
      role="status"
      data-testid="connect-model-nudge"
      className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-[length:var(--text-body)] text-[var(--app-fg)]"
    >
      <span className="min-w-0 flex-1">
        Connect a model so your sessions have something to work with.
      </span>
      <ConnectModelButton />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="connect-model-nudge-dismiss"
        onClick={() => {
          dismissedThisLoad = true;
          setDismissed(true);
        }}
      >
        Not now
      </Button>
    </div>
  );
}

/** #6211 R13: only a read that answered can say there are no sessions. */
export function sessionsAreEmpty(read: {
  isLoading: boolean;
  error: string | null;
  count: number;
}): boolean {
  return !read.isLoading && !read.error && read.count === 0;
}

/**
 * #6211 R13: what the session list shows with no sessions at all. It leads to a
 * model first when none is connected, because a session could not start without one.
 */
export function SessionsEmptyState({
  api,
  onNewSession,
}: {
  api: ApiClient | null;
  onNewSession: () => void;
}) {
  const connection = useModelConnection(api);
  const needsModel = connection.status === "none";
  return (
    <StatePanel
      variant="empty"
      testId="sessions-empty-state"
      title="No sessions yet"
      description={
        needsModel
          ? "Connect a model first, then start a session."
          : "Start a session to get going."
      }
      action={
        needsModel ? (
          <ConnectModelButton />
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="sessions-empty-new"
            onClick={onNewSession}
          >
            New session
          </Button>
        )
      }
    />
  );
}

/**
 * #6211 R13: the Create page's line for a local target with no model it can run. It
 * does not disable Create: a false negative would lock out a working install, and a
 * spawn with no credential already reports why.
 */
export function ConnectModelCreateLine({
  api,
  remoteTarget,
  availableAgents,
}: {
  api: ApiClient | null;
  remoteTarget: boolean;
  /** What the target reports it can run; undefined means no answer. */
  availableAgents?: AgentType[];
}) {
  const connection = useModelConnection(api);
  const noneRunnableYet =
    !remoteTarget &&
    connection.status === "connected" &&
    !startProvider(connection.providers, availableAgents);
  // The status read stops at the first provider it finds, and one it has not listed may be
  // the one this node can run, so the full read decides before the line stays up.
  const everyProvider = useModelConnection(api, {
    everyProvider: noneRunnableYet,
  });
  const noneRunnable =
    noneRunnableYet && !startProvider(everyProvider.providers, availableAgents);
  if (remoteTarget || (connection.status !== "none" && !noneRunnable)) {
    return null;
  }
  return (
    <div
      data-testid="connect-model-create-line"
      className="flex flex-wrap items-center gap-2 text-[length:var(--text-body)] text-[var(--app-hint)]"
    >
      <span className="min-w-0 flex-1">
        {noneRunnable
          ? "This node has no command-line tool for your connected model. Connect one it can run."
          : "Connect a model to start a session."}
      </span>
      <ConnectModelButton variant="outline" />
    </div>
  );
}
