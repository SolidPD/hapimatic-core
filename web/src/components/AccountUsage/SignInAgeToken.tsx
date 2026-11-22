// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SignInAgeToken — how long an Anthropic login has lived on one node (issue
 * #6801, R6-R9): "12d" while it refreshes, "died 30d" (the age at which it
 * stopped refreshing, which does not rise) or "died" when the node has no time
 * for the death. Shown beside a node pill on Provider Accounts and in the
 * account switcher's card row.
 *
 * The token owns its clock: it reads the one shared minute clock
 * (`useMinuteNow`) and computes the age itself, so its parents never re-render
 * every minute. It is a button (`HoverTooltipButton`) so it has a keyboard stop,
 * the full sentence as its accessible name, and a tap-open tooltip on touch; its
 * hit area is padded to 24 x 24 px with negative margins, so the 10 px text keeps
 * the row's height. It never toggles or selects the card it sits on.
 *
 * `lift` (the Provider Accounts node row): the hit area is raised 4 px, so it
 * ends above the "set default" caption under the pill instead of reaching into
 * it; the row leaves 8 px between wrapped lines for the part above (#6801 R9,
 * measured at 393 px). Elsewhere the hit area is centred on the text.
 *
 * Issue #6161 (R10, R12): inside the warning window the text is the countdown
 * ("2d left" / "due") in `var(--status-warn)`, and the sentence says when the
 * sign-in ends. `surface` picks the sentence: `node-row` adds "· tap the node to
 * sign in again" (the pill beside it opens the re-login); `switcher`, the
 * default, does not, because the switcher shows no node pill.
 */
import {
  computeSignInAge,
  computeSignInEnding,
  isEstimatedDeadline,
  isSignInDeath,
  resolveEntryDeadline,
  type SignInAgeInput,
} from "@hapi/protocol";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { useMinuteNow } from "@/lib/pins/useMinuteNow";
import { formatSignInAge, type SignInAgeSurface } from "@/lib/signInAge";

export function SignInAgeToken(props: {
  entry: SignInAgeInput | undefined;
  nodeLabel: string;
  lift?: boolean;
  surface?: SignInAgeSurface;
}) {
  const { entry, nodeLabel, lift = false, surface = "switcher" } = props;
  const now = useMinuteNow();
  if (!entry) return null;
  const age = computeSignInAge(entry, now);
  if (!age) return null;
  const resolved = resolveEntryDeadline(entry, now);
  const label = formatSignInAge(age, nodeLabel, {
    deadline: {
      at: resolved.at,
      estimated: isEstimatedDeadline(
        resolved.source,
        entry.signInDeadlineSource
      ),
      ending: computeSignInEnding(entry, now),
    },
    surface,
    nowMs: now,
  });
  if (!label) return null;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const color =
    label.state === "ending" || label.state === "due"
      ? "text-[var(--status-warn)]"
      : label.state !== "running" && isSignInDeath(label.state)
        ? "text-[var(--status-hot)]"
        : "text-[var(--app-hint)]";
  // 24 px box, 12 px of layout height either way: centred (6 px above and
  // below) or lifted (10 px above, 2 px below). Lifted, the text sits at the
  // box's foot (2 px up), which is the 12 px slot the row centres on the pill,
  // so only the hit area rises.
  const vertical = lift
    ? "-mb-0.5 -mt-2.5 items-end pb-0.5"
    : "-my-1.5 items-center";
  return (
    <HoverTooltipButton
      type="button"
      data-testid="account-sign-in-age"
      data-state={label.state}
      aria-label={label.tooltip}
      content={label.tooltip}
      onClick={stop}
      onPointerDown={stop}
      className={`-mx-1 ${vertical} inline-flex h-6 min-w-6 shrink-0 justify-center whitespace-nowrap rounded px-1 text-[length:var(--text-caption-xs)] leading-3 hover:opacity-80 ${color}`}
    >
      {label.text}
    </HoverTooltipButton>
  );
}
