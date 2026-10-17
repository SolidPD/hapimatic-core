// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiClient } from "@/api/client";
import type { Session } from "@/types/api";
import { useOptionalAppContext } from "@/lib/app-context";
import { useSupportChannel } from "@/hooks/queries/useSupportChannel";
import { SupportEscalationModal } from "@/components/SupportEscalationModal";

/**
 * SupportSessionBar — the persistent "Contact a human" control of the in-app
 * support session (issue #4371 Task 6, R3). Seated directly under the session
 * header (the header's icon row is a closed registry, #2366), and rendered ONLY
 * when the session runs in the support workspace — every other session renders
 * nothing.
 */
export function SupportSessionBar(props: {
  session: Session;
  api: ApiClient | null;
}) {
  const { channel } = useSupportChannel(props.api);
  const appCtx = useOptionalAppContext();
  const [open, setOpen] = useState(false);

  if (
    !props.api ||
    !channel ||
    props.session.metadata?.path !== channel.workspacePath
  ) {
    return null;
  }

  return (
    <div
      data-testid="support-session-bar"
      className="flex items-center justify-between gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-1.5"
    >
      <span className="flex items-center gap-1.5 text-sm text-[var(--app-hint)]">
        <LifeBuoy className="h-4 w-4 text-[var(--brand-accent)]" />
        Help session
      </span>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid="support-contact-human"
        className="h-auto min-h-9 rounded-md border border-[var(--app-border)] px-3 py-1 text-sm font-normal text-[var(--app-fg)] hover:bg-[var(--app-bg)]"
      >
        Contact a human
      </Button>
      <SupportEscalationModal
        open={open}
        onClose={() => setOpen(false)}
        api={props.api}
        channel={channel}
        sessionId={props.session.id}
        replyEmail={appCtx?.user?.username ?? null}
      />
    </div>
  );
}
