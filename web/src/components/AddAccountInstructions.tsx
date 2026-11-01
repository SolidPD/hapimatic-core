// SPDX-License-Identifier: AGPL-3.0-only
import type { ProviderId } from "@hapi/protocol";

type AddAccountInstructionsProps = {
  /**
   * Intro sentence shown above the numbered steps. Defaults to the modal's
   * existing copy so `AccountSelectorEmptyState`'s help panel is byte-identical
   * after it adopts this component.
   */
  intro?: string;
  /**
   * Which provider's host-side add procedure to render (issue #3806, epic #3345).
   * Defaults to `"anthropic"` — the Anthropic copy is BYTE-IDENTICAL to the
   * pre-#3806 output, so every existing caller + the existing test are unaffected.
   * `"openai"` / `"google"` render the host-side Codex / Gemini instructions
   * the Accounts page's "Other ways to add an account" popover shows for those
   * sections (#4466 R10). [ER 2026-09-19: K1]
   */
  provider?: ProviderId;
  /**
   * #4466: whether the OpenAI steps end with "Or use “+ Add” on this page".
   * Defaults to `true` (the popover). The "+ Add" modal's own fallback passes
   * `false`, because it shows only when in-app sign-in is unavailable there.
   */
  showInAppStep?: boolean;
};

/**
 * AddAccountInstructions — the shared, single-source-of-truth host-login
 * procedure for adding a provider account (epic #2049, Sub-Issue F / #2055;
 * extended to non-Anthropic providers by #3806 / epic #3345).
 *
 * The Anthropic variant (the default) is the `claude /login` OAuth flow, reused by
 * the `AccountSelectorEmptyState` "Log in on the host" help panel and the
 * Accounts page's "Other ways to add an account" popover (#4466 R10), so the
 * copy lives in exactly one place (R4 — no duplication). The `provider` prop
 * adds the OpenAI (Codex) and Google Gemini host-side procedures, which the
 * popover shows for those sections; the in-app add is each section's "+ Add".
 * The "+ Add" modal's OpenAI fallback (`NodeLoginList`) also renders the OpenAI
 * steps, without the "+ Add" step (`showInAppStep={false}`).
 *
 * Presentational and dependency-free. Renders ONLY the intro paragraph + the
 * numbered step list as a bare fragment — the heading, "Back" button, padding,
 * and any collapsible chrome are caller-owned. Rendering a fragment (not a
 * wrapper element) keeps the modal path byte-identical: these two elements were
 * already direct children of `AccountSelectorEmptyState`'s flex container.
 */
export function AddAccountInstructions({
  intro = "You can also add an account by logging in directly on the target machine:",
  provider = "anthropic",
  showInAppStep = true,
}: AddAccountInstructionsProps) {
  if (provider === "openai") {
    return (
      <>
        <p className="text-[var(--app-hint)]">{intro}</p>
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
        <p className="text-[var(--app-hint)]">{intro}</p>
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
      <p className="text-[var(--app-hint)]">{intro}</p>
      <ol className="list-decimal space-y-1 pl-5 text-[var(--app-hint)]">
        <li>
          Run <code className="text-[var(--app-fg)]">claude /login</code> on the
          machine.
        </li>
        <li>Open the OAuth URL it prints and approve access.</li>
        <li>Copy the verification code back into the terminal.</li>
        <li>
          Hapimatic auto-captures the new account — it then appears in this
          list.
        </li>
      </ol>
    </>
  );
}
