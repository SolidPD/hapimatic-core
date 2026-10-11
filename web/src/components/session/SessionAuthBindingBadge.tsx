// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionAuthBindingBadge — the Row-1 auth-binding chip for NON-Claude sessions
 * (issue #3351, epic #3345 Sub-Issue F). It sits parallel to the Claude Account
 * Badge ({@link SessionAccountBadge}): that badge renders nothing for a
 * Codex/Gemini/OpenCode session (`useSessionAccountEmail` yields no email), so
 * this badge fills that same slot to name WHICH auth identity the session is
 * bound to — a subscription login ("ChatGPT"), a gateway key ("OpenRouter"), a
 * managed API key (its vault label), or the host's own inherited credential
 * ("Host default").
 *
 * It reads ONLY `session.metadata.authBinding` (stamped at spawn by the daemon
 * → CLI child, refreshed on an account switch — see `AuthBindingSchema`). The
 * value is label-only by construction: the raw key never leaves the node vault,
 * so this component can never surface a secret.
 *
 * Informational, not interactive: unlike the Account Badge (which opens the
 * Session Configuration modal to switch accounts), there is no account-switch
 * for a non-Claude flavor, so this is a quiet non-tappable `Badge` with a
 * descriptive tooltip (R2/R3). Claude sessions render nothing here — their
 * identity is the Account Badge.
 */
import { Badge } from "@/components/ui/badge";
import { LOOP_CRON_SLOT_PX } from "@/components/session/rowAnchors";
import type { AuthBinding } from "@hapi/protocol";

/** Structural input — matches both the full `Metadata` and the projected
 *  `SessionSummaryMetadata` (both carry `flavor` + `authBinding`). */
export interface SessionAuthBindingInput {
  metadata?: {
    flavor?: string | null;
    authBinding?: AuthBinding;
  } | null;
}

/**
 * Map a binding (+ flavor, to distinguish inherited-gemini from inherited-codex)
 * to the chip text and its tooltip. The tooltip documents the R2 limitation for
 * gemini (no Hapimatic-supplied credential; a Google email is not derivable from
 * an API key) and the real-vs-EQ billing nature per #3353's mapping.
 */
export function describeAuthBinding(
  binding: AuthBinding,
  flavor: string | null | undefined
): { text: string; title: string } {
  switch (binding.kind) {
    case "subscription-account": {
      // Non-Claude subscription = Codex's ChatGPT login (Claude never reaches
      // this component). displayIdentity is "ChatGPT" (its account label lives in
      // the id-token, unreadable at the daemon).
      const id = binding.displayIdentity || "ChatGPT";
      return {
        text: id,
        title: `${id} — authenticated via a ChatGPT subscription login (subscription-billed; shown as equivalent cost).`,
      };
    }
    case "gateway-key": {
      const id = binding.displayIdentity || "OpenRouter";
      return {
        text: id,
        title: `${id} — OpenRouter gateway API key (per-token, real cost). The key stays node-local; only its label is shown.`,
      };
    }
    case "api-key": {
      const id = binding.displayIdentity || "API key";
      return {
        text: id,
        title: `${id} — a Hapimatic-managed API key (per-token, real cost). The key stays node-local; only its label is shown.`,
      };
    }
    case "inherited":
    default:
      if (flavor === "gemini") {
        return {
          text: "Host default",
          title:
            "Host default — Hapimatic supplies no Gemini credential for this session; it inherits the host environment's auth. A Google account email is not derivable from a Gemini API key.",
        };
      }
      return {
        text: "Host default",
        title:
          "Host default — this session inherits the host environment's own credentials; Hapimatic did not bind a managed credential.",
      };
  }
}

export function SessionAuthBindingBadge({
  session,
}: {
  session: SessionAuthBindingInput;
}) {
  const flavor = session.metadata?.flavor ?? null;
  const binding = session.metadata?.authBinding;
  // Render nothing for: a Claude session (the Account Badge owns its identity), a
  // default/unknown flavor, or a legacy/in-flight session with no binding stamped.
  if (!binding) return null;
  if (!flavor || flavor === "claude") return null;

  const { text, title } = describeAuthBinding(binding, flavor);
  return (
    <Badge
      variant="subscription"
      data-testid="session-auth-binding-badge"
      data-auth-kind={binding.kind}
      title={title}
      aria-label={`Auth binding: ${text}. ${title}`}
      className="shrink-0 justify-center overflow-hidden whitespace-nowrap font-normal"
      style={{ maxWidth: LOOP_CRON_SLOT_PX }}
    >
      <span className="truncate">{text}</span>
    </Badge>
  );
}
