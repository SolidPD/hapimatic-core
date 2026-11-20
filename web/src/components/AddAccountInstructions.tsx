// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderId } from "@hapi/protocol";

type AddAccountInstructionsProps = {
  /**
   * Intro sentence shown above the numbered steps. Defaults per provider: the
   * Anthropic in-app sign-in sentence, or the host-login sentence for OpenAI and
   * Google.
   */
  intro?: string;
  /**
   * Which provider's add procedure to render (issue #3806, epic #3345). Defaults
   * to `"anthropic"`. `"openai"` / `"google"` render the host-side Codex / Gemini
   * instructions the Accounts page's "Other ways to add an account" popover shows
   * for those sections (#4466 R10). [ER 2026-09-19: K1]
   */
  provider?: ProviderId;
  /**
   * #6837 (R1): where the Anthropic steps are shown. `"provider-accounts"` (the
   * default) is the Provider Accounts page's "Other ways to add an account"
   * popover, which already sits beside the Anthropic "Add" pill; `"account-selector"`
   * is the session account switcher's empty state, which first sends the user to
   * that page.
   */
  anthropicContext?: "provider-accounts" | "account-selector";
  /**
   * #4466: whether the OpenAI steps end with "Or use “+ Add” on this page".
   * Defaults to `true` (the popover). The "+ Add" modal's own fallback passes
   * `false`, because it shows only when in-app sign-in is unavailable there.
   */
  showInAppStep?: boolean;
};

const HOST_LOGIN_INTRO =
  "You can also add an account by logging in directly on the target machine:";
const ANTHROPIC_INTRO = "Add a Claude account in Hapimatic itself:";

/**
 * AddAccountInstructions — the shared, single-source-of-truth procedure for adding
 * a provider account (epic #2049, Sub-Issue F / #2055; extended to non-Anthropic
 * providers by #3806 / epic #3345).
 *
 * The Anthropic variant (the default) points to Hapimatic's own sign-in under
 * Settings → Provider Accounts (#6837 R1). Since #6800 a sign-in made from the
 * user's own shell writes `~/.claude`, which Hapimatic sessions do not read, so
 * nothing captures it. The Add dialog's "Use a terminal instead" route is a
 * terminal sign-in Hapimatic does use, but the dialog offers it only on a tenant
 * VM (`AnthropicLoginStep.tsx`, `step.inVm`), so the popover step names it
 * conditionally. It is shown by the `AccountSelectorEmptyState`
 * "Other ways to add an account" panel and the Accounts page's popover of the
 * same name (#4466 R10), so the copy lives in exactly one place. The `provider`
 * prop adds the OpenAI (Codex) and Google Gemini host-side procedures, which the
 * popover shows for those sections; the in-app add is each section's "+ Add".
 * The "+ Add" modal's OpenAI fallback (`NodeLoginList`) also renders the OpenAI
 * steps, without the "+ Add" step (`showInAppStep={false}`).
 *
 * Presentational and dependency-free. Renders ONLY the intro paragraph, the
 * numbered step list and (Anthropic) the closing note as a bare fragment — the
 * heading, "Back" button, padding, and any collapsible chrome are caller-owned.
 * A fragment (not a wrapper element) keeps each element a direct child of the
 * caller's flex container (`AccountSelectorEmptyState`, the popover).
 */
export function AddAccountInstructions({
  intro,
  provider = "anthropic",
  showInAppStep = true,
  anthropicContext = "provider-accounts",
}: AddAccountInstructionsProps) {
  if (provider === "openai") {
    return (
      <>
        <p className="text-[var(--app-hint)]">{intro ?? HOST_LOGIN_INTRO}</p>
        <ol className="list-decimal space-y-1 pl-5 text-[var(--app-hint)]">
          <li>
            Run <code className="text-[var(--app-fg)]">codex login</code> on the
            machine and complete the ChatGPT sign-in it opens.
          </li>
          <li>
            Hapimatic reads the host{" "}
            <code className="text-[var(--app-fg)]">~/.codex</code> login as this
            node&apos;s OpenAI account.
          </li>
          {showInAppStep && (
            <li>
              Or use &ldquo;+ Add&rdquo; on this page: ChatGPT sign-in or a
              Codex API key, on any node.
            </li>
          )}
        </ol>
      </>
    );
  }

  if (provider === "google") {
    return (
      <>
        <p className="text-[var(--app-hint)]">{intro ?? HOST_LOGIN_INTRO}</p>
        <ol className="list-decimal space-y-1 pl-5 text-[var(--app-hint)]">
          <li>
            Add a <code className="text-[var(--app-fg)]">gemini</code> key under
            Provider API Keys on this node (its local vault), or set{" "}
            <code className="text-[var(--app-fg)]">GEMINI_API_KEY</code> via the
            node&apos;s daemon env-file drop-in.
          </li>
          <li>
            Restart the daemon so the key takes effect (a drop-in change needs a
            daemon restart).
          </li>
          <li>
            The Gemini section then shows the bound key&apos;s source for this
            node.
          </li>
        </ol>
      </>
    );
  }

  return (
    <>
      <p className="text-[var(--app-hint)]">{intro ?? ANTHROPIC_INTRO}</p>
      <ol className="list-decimal space-y-1 pl-5 text-[var(--app-hint)]">
        {anthropicContext === "account-selector" ? (
          <>
            <li>Open Settings → Provider Accounts</li>
            <li>In Anthropic, choose Add, then Sign in to Claude Code</li>
            <li>The account then appears in this list</li>
          </>
        ) : (
          <>
            <li>In Anthropic, choose Add, then Sign in to Claude Code</li>
            <li>
              If that dialog offers Use a terminal instead, you can sign in from
              a terminal there
            </li>
          </>
        )}
      </ol>
      <p className="text-[var(--app-hint)]">
        A sign-in you make from your own shell (running{" "}
        <code className="text-[var(--app-fg)]">claude</code> and typing{" "}
        <code className="text-[var(--app-fg)]">/login</code>) is for terminal{" "}
        <code className="text-[var(--app-fg)]">claude</code> only: Hapimatic
        sessions do not use it.
      </p>
    </>
  );
}
