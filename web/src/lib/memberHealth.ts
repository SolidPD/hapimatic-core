// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The member-health model behind the health strip (issue #6161, NP-1 / NP-2,
 * pattern C). A card lists an unbounded set of members (the nodes an account
 * is on; #6884 reuses it for the accounts on a node), and its summary is
 * bounded by the STATES, never by the member count: a state with one member
 * names it, a state with more shows a count, so 1 member and 25 members draw
 * the same one-line summary.
 *
 * Worst first: re-login, then due, then ending (fewest days first), then
 * quarantined, then running, then not read. `unread` is a member whose health
 * this page has not read (an offline node, or the read still loading): it is
 * never painted as running, because nothing says it runs.
 *
 * Pure functions only, so the account card's node row (`AccountNodeRow`) and
 * the node card's account row (`NodeAccountRow`, #6884) share them: the
 * per-account state rule (`signInMemberState`) lives here ONCE, so the two
 * rows cannot disagree on a state.
 */
import {
  computeSignInEnding,
  type SignInAgeInput,
  type SignInEnding,
} from "@hapi/protocol";
import type { HealthTone } from "@/components/ui/HealthStrip";

export type MemberHealthState =
  | "relogin"
  | "due"
  | "ending"
  | "quarantined"
  | "running"
  | "unread";

/** Severity order, worst first. */
export const MEMBER_HEALTH_SEVERITY: Record<MemberHealthState, number> = {
  relogin: 0,
  due: 1,
  ending: 2,
  quarantined: 3,
  running: 4,
  unread: 5,
};

/** The strip tone each state paints. */
export function memberHealthTone(state: MemberHealthState): HealthTone {
  switch (state) {
    case "relogin":
      return "hot";
    case "due":
    case "ending":
      return "warn";
    case "quarantined":
      return "held";
    case "running":
      return "ok";
    case "unread":
      return "unknown";
  }
}

/** A state that needs attention: shown in the summary text, and as a wide tile. */
export function isAttentionState(state: MemberHealthState): boolean {
  return (
    state === "relogin" ||
    state === "due" ||
    state === "ending" ||
    state === "quarantined"
  );
}

/** A read member's state (never `unread`), with its window facts. */
export type SignInMemberState = {
  state: Exclude<MemberHealthState, "unread">;
  /** Whole days left, for a `due` or `ending` member. */
  daysLeft?: number;
  ending: SignInEnding | null;
  /** Its chip's tap and its tile's button may open the re-login. */
  canRelogin: boolean;
};

/**
 * One account's state on one node at `now` (#6161 NP-1; shared with #6884).
 * Order: a quarantined record is `quarantined` even though it also needs a
 * re-login (its re-login stays possible when `needsRelogin`); then re-login;
 * then the one warning-window rule (`computeSignInEnding`: `due` or `ending`);
 * else running. The caller decides `unread` first (a member it has not read).
 */
export function signInMemberState(
  input: { signIn: SignInAgeInput | undefined; needsRelogin: boolean },
  now: number
): SignInMemberState {
  const { signIn, needsRelogin } = input;
  if (signIn?.quarantined === true) {
    return {
      state: "quarantined",
      ending: null,
      canRelogin: needsRelogin,
    };
  }
  if (needsRelogin) {
    return { state: "relogin", ending: null, canRelogin: true };
  }
  const ending = signIn ? computeSignInEnding(signIn, now) : null;
  if (ending) {
    return {
      state: ending.state === "due" ? "due" : "ending",
      daysLeft: ending.daysLeft,
      ending,
      canRelogin: true,
    };
  }
  return { state: "running", ending: null, canRelogin: false };
}

/**
 * A tile's state words. For re-login, due and ending they repeat the token
 * ("died 30d", "due", "2d left") and the ring, so a phone hides them
 * (`phoneHidden`) to keep the tile's controls on the line; "quarantined"
 * always shows, because its token is only an age.
 */
export function memberStateWords(state: MemberHealthState): {
  text: string;
  className: string;
  phoneHidden: boolean;
} {
  switch (state) {
    case "relogin":
      return {
        text: "re-login required",
        className: "text-[var(--status-hot)]",
        phoneHidden: true,
      };
    case "due":
      return {
        text: "reached its end date",
        className: "text-[var(--status-warn)]",
        phoneHidden: true,
      };
    case "ending":
      return {
        text: "ending soon",
        className: "text-[var(--status-warn)]",
        phoneHidden: true,
      };
    case "quarantined":
      return {
        text: "quarantined",
        className: "text-[var(--app-hint)]",
        phoneHidden: false,
      };
    case "unread":
      return {
        text: "not read",
        className: "text-[var(--app-hint)]",
        phoneHidden: false,
      };
    default:
      return {
        text: "running",
        className: "text-[var(--app-hint)]",
        phoneHidden: false,
      };
  }
}

/** The minimum a member carries for the model. */
export type HealthMember = {
  state: MemberHealthState;
  /** Whole days left, for an `ending` member (fewest first). */
  daysLeft?: number;
};

/** Members sorted worst first; ties keep their input order. */
export function sortWorstFirst<T extends HealthMember>(members: T[]): T[] {
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const s =
        MEMBER_HEALTH_SEVERITY[a.m.state] - MEMBER_HEALTH_SEVERITY[b.m.state];
      if (s !== 0) return s;
      if (a.m.state === "ending") {
        const d = (a.m.daysLeft ?? 0) - (b.m.daysLeft ?? 0);
        if (d !== 0) return d;
      }
      return a.i - b.i;
    })
    .map(x => x.m);
}

export type MemberHealthBucketKey =
  | "relogin"
  | "ending"
  | "quarantined"
  | "running"
  | "unread";

/** One summary bucket: its states and its members, worst first. */
export type MemberHealthBucket<T> = {
  key: MemberHealthBucketKey;
  /** The word after a single member's chip ("re-login", "ending", …). */
  one: string;
  /** The word after a count ("2 ending", …). */
  many: string;
  /** The tooltip heading for the bucket. */
  title: string;
  members: T[];
};

const BUCKETS: {
  key: MemberHealthBucketKey;
  states: MemberHealthState[];
  one: string;
  many: string;
  title: string;
}[] = [
  {
    key: "relogin",
    states: ["relogin"],
    one: "re-login",
    many: "re-login",
    title: "re-login required",
  },
  {
    key: "ending",
    states: ["due", "ending"],
    one: "ending",
    many: "ending",
    title: "ending soon",
  },
  {
    key: "quarantined",
    states: ["quarantined"],
    one: "quarantined",
    many: "quarantined",
    title: "quarantined",
  },
  {
    key: "running",
    states: ["running"],
    one: "running",
    many: "running",
    title: "running",
  },
  {
    key: "unread",
    states: ["unread"],
    one: "not read",
    many: "not read",
    title: "not read",
  },
];

/** The non-empty buckets, worst first, each with its members worst first. */
export function bucketMembers<T extends HealthMember>(
  members: T[]
): MemberHealthBucket<T>[] {
  const sorted = sortWorstFirst(members);
  return BUCKETS.map(b => ({
    key: b.key,
    one: b.one,
    many: b.many,
    title: b.title,
    members: sorted.filter(m => b.states.includes(m.state)),
  })).filter(b => b.members.length > 0);
}

/** The summary text colour of each bucket's word or count. */
export const MEMBER_BUCKET_TEXT_CLASS: Record<MemberHealthBucketKey, string> = {
  relogin: "text-[var(--status-hot)]",
  ending: "text-[var(--status-warn)]",
  quarantined: "text-[var(--app-hint)]",
  running: "text-[var(--app-hint)]",
  unread: "text-[var(--app-hint)]",
};

/** The buckets that need attention (re-login, ending, quarantined). */
export function attentionBuckets<T extends HealthMember>(
  members: T[]
): MemberHealthBucket<T>[] {
  return bucketMembers(members).filter(
    b => b.key === "relogin" || b.key === "ending" || b.key === "quarantined"
  );
}

/** At most this many names per tooltip line, then "+N". */
const NAMES_PER_LINE = 4;

/**
 * The summary's tooltip: one heading line, then one line per bucket, so the
 * tooltip is bounded by the states too ("2 ending: RP2, SP7").
 */
export function memberHealthTooltipLines<T extends HealthMember>(
  members: T[],
  nameOf: (member: T) => string,
  heading: string
): string[] {
  const lines = [heading];
  for (const b of bucketMembers(members)) {
    const n = b.members.length;
    if (b.key === "running" || b.key === "unread") {
      lines.push(`${n} ${b.title}`);
      continue;
    }
    const names = b.members.slice(0, NAMES_PER_LINE).map(nameOf).join(", ");
    const more = n > NAMES_PER_LINE ? ` +${n - NAMES_PER_LINE}` : "";
    lines.push(`${n} ${b.title}: ${names}${more}`);
  }
  return lines;
}
