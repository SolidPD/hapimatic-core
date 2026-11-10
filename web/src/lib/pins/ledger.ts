// SPDX-License-Identifier: AGPL-3.0-only
import {
  answerOnRecord,
  PIN_KINDS,
  PinEvidenceSchema,
  PinIfUnansweredSchema,
  PinOptionSchema,
  PinStepSchema,
  type Pin,
  type PinAnswer,
  type PinEvidence,
  type PinIfUnanswered,
  type PinOption,
  type PinStep,
} from "@hapi/protocol";
import {
  PINS_VIEW_BUILTIN,
  type PinsViewDirection,
  type PinsViewSort,
} from "@hapi/protocol/schemas";
import { formatRelativeTimeCompact } from "@/lib/sessionHelpers";
import { normalizeSearchText } from "@/lib/sessionSearchFilterSort";
import type { StagedPin } from "@/lib/pins/staging";

/**
 * #6449: the Pins Ledger's pure helpers — the view model, the sections, the
 * order, and the display values. React-free, so the later sub-issues (D's
 * answering, E's toolbar and timeline, G's links, H's Project Managers) reuse
 * them. Design of record: `docs/design/pins/pins-mockup-v6.html`.
 */

/**
 * A pin plus its strictly parsed parts. A's `PinSchema` checks only the
 * fields it names (strings, numbers, booleans, `anchor`, `answers`), because a
 * record may come from another node's build; `options`, `steps`, `evidence`,
 * and `ifUnanswered` reach the client unchecked. Each item is parsed with
 * A's strict schema (a step's links re-checked for `http:`/`https:`), a
 * failing item is dropped, and `degraded`
 * says so, so the pin can point at its Text fallback.
 */
export type PinViewModel = {
  pin: Pin;
  options: PinOption[];
  steps: PinStep[];
  evidence: PinEvidence[];
  ifUnanswered: PinIfUnanswered | null;
  degraded: boolean;
};

function parseItems<T>(
  raw: unknown,
  parse: (item: unknown) => { success: true; data: T } | { success: false }
): { items: T[]; dropped: boolean } {
  if (raw === undefined || raw === null) return { items: [], dropped: false };
  if (!Array.isArray(raw)) return { items: [], dropped: true };
  const items: T[] = [];
  let dropped = false;
  for (const item of raw) {
    const result = parse(item);
    if (result.success) items.push(result.data);
    else dropped = true;
  }
  return { items, dropped };
}

// Keyed by the pin object: TanStack's structural sharing keeps an unchanged
// pin's identity across refetches, so its view model (and every memoized row
// fed by it) stays identical too.
const viewModels = new WeakMap<Pin, PinViewModel>();

export function toPinViewModel(pin: Pin): PinViewModel {
  const cached = viewModels.get(pin);
  if (cached) return cached;
  const record = pin as unknown as Record<string, unknown>;
  const options = parseItems(record.options, item =>
    PinOptionSchema.safeParse(item)
  );
  const steps = parseItems(record.steps, item => PinStepSchema.safeParse(item));
  const evidence = parseItems(record.evidence, item =>
    PinEvidenceSchema.safeParse(item)
  );
  let ifUnanswered: PinIfUnanswered | null = null;
  let deadlineDropped = false;
  if (record.ifUnanswered !== undefined && record.ifUnanswered !== null) {
    const parsed = PinIfUnansweredSchema.safeParse(record.ifUnanswered);
    if (parsed.success) ifUnanswered = parsed.data;
    else deadlineDropped = true;
  }
  const model: PinViewModel = {
    pin,
    options: options.items,
    steps: steps.items,
    evidence: evidence.items,
    ifUnanswered,
    degraded:
      options.dropped || steps.dropped || evidence.dropped || deadlineDropped,
  };
  viewModels.set(pin, model);
  return model;
}

// ── Sections ────────────────────────────────────────────────────────────────

export type PinSectionId = "action" | "completed";

export type PinSection = {
  id: PinSectionId;
  title: string;
  tone: PinSectionId;
  pins: PinViewModel[];
};

export const COMPLETED_STATUSES: ReadonlySet<string> = new Set([
  "answered",
  "auto-answered",
  "withdrawn",
  "dismissed",
]);

/**
 * Split pins into Action Items (status `open`) and Completed (answered,
 * auto-answered, withdrawn, dismissed), each in its order. Dashboards are
 * bucketed by kind FIRST, whatever their status, so a withdrawn dashboard
 * never lands in Completed (H's Project Managers section renders them). A
 * status this build does not know (a newer peer's) goes nowhere.
 */
export function groupPins(
  pins: readonly PinViewModel[],
  deadlineOf?: DeadlineOf
): { sections: PinSection[]; dashboards: PinViewModel[] } {
  const action: PinViewModel[] = [];
  const completed: PinViewModel[] = [];
  const dashboards: PinViewModel[] = [];
  for (const model of pins) {
    const { pin } = model;
    if (pin.kind === "dashboard") dashboards.push(model);
    else if (pin.status === "open") action.push(model);
    else if (COMPLETED_STATUSES.has(pin.status)) completed.push(model);
  }
  action.sort((a, b) => PIN_SORTS.priority(a.pin, b.pin, deadlineOf));
  completed.sort((a, b) => compareCompleted(a.pin, b.pin));
  return {
    sections: [
      { id: "action", title: "Action Items", tone: "action", pins: action },
      {
        id: "completed",
        title: "Completed",
        tone: "completed",
        pins: completed,
      },
    ],
    dashboards,
  };
}

// ── Order ───────────────────────────────────────────────────────────────────

/** A pin's automatic-pick instant in epoch ms, when known (F, #6452, computes it). */
export type DeadlineOf = (pin: Pin) => number | undefined;

const STAKES_WEIGHT: Record<string, number> = {
  irreversible: 3,
  costly: 2,
  reversible: 1,
};
const RISK_WEIGHT: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** An ISO time in epoch ms; one that does not parse sorts as the far future. */
export function epochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function compareNumbers(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareKeys(a: Pin, b: Pin): number {
  if (a.key === b.key) return 0;
  return a.key < b.key ? -1 : 1;
}

function comparePriorityTerms(a: Pin, b: Pin, deadlineOf: DeadlineOf): number {
  return (
    compareNumbers(Number(b.blocking), Number(a.blocking)) ||
    compareNumbers(
      STAKES_WEIGHT[b.stakes] ?? 0,
      STAKES_WEIGHT[a.stakes] ?? 0
    ) ||
    compareNumbers(RISK_WEIGHT[b.risk] ?? 0, RISK_WEIGHT[a.risk] ?? 0) ||
    compareNumbers(
      deadlineOf(a) ?? Number.POSITIVE_INFINITY,
      deadlineOf(b) ?? Number.POSITIVE_INFINITY
    ) ||
    compareNumbers(epochMs(a.createdAt), epochMs(b.createdAt))
  );
}

/** Each kind's position in `PIN_KINDS`: the Kind sort's and grouping's order. */
export const PIN_KIND_INDEX: ReadonlyMap<string, number> = new Map(
  PIN_KINDS.map((kind, index) => [kind, index])
);

/** A comparator's signature: `sessionId` is only read by `source`. */
export type PinComparator = (
  a: Pin,
  b: Pin,
  deadlineOf?: DeadlineOf,
  sessionId?: string
) => number;

const noDeadline: DeadlineOf = () => undefined;

/**
 * Comparators, each the order for `dir: "desc"` (the highest priority first).
 * `priority` (R5): starred, then blocking, then stakes (irreversible > costly >
 * reversible), then risk (high > medium > low), then the automatic-pick
 * deadline (soonest first; none last), then the oldest `createdAt`, then `key`
 * — total and stable. An unknown stakes or risk value weighs 0. The deadline
 * term defaults to "none" because A stores `ifUnanswered.after` as a duration;
 * F supplies `deadlineOf` and this order does not change.
 *
 * E's six (#6451) compare only their own key, a pin without one last:
 * `deadline` soonest first, `updated` and `created` newest first, `kind` in
 * `PIN_KINDS` order, `title` Z→A (the session list's Name sort), and `source`
 * this session's own pins first, then by session id. {@link sortPins} adds
 * starred-first, the direction and the tie-breaks.
 */
export const PIN_SORTS = {
  priority(a: Pin, b: Pin, deadlineOf: DeadlineOf = noDeadline): number {
    return (
      compareNumbers(Number(b.starred), Number(a.starred)) ||
      comparePriorityTerms(a, b, deadlineOf) ||
      compareKeys(a, b)
    );
  },
  deadline(a: Pin, b: Pin, deadlineOf: DeadlineOf = noDeadline): number {
    return compareNumbers(
      deadlineOf(a) ?? Number.POSITIVE_INFINITY,
      deadlineOf(b) ?? Number.POSITIVE_INFINITY
    );
  },
  updated(a: Pin, b: Pin): number {
    return compareNewest(epochMs(a.updatedAt), epochMs(b.updatedAt));
  },
  created(a: Pin, b: Pin): number {
    return compareNewest(epochMs(a.createdAt), epochMs(b.createdAt));
  },
  kind(a: Pin, b: Pin): number {
    return compareNumbers(
      PIN_KIND_INDEX.get(a.kind) ?? Number.POSITIVE_INFINITY,
      PIN_KIND_INDEX.get(b.kind) ?? Number.POSITIVE_INFINITY
    );
  },
  title(a: Pin, b: Pin): number {
    return normalizeSearchText(b.title).localeCompare(
      normalizeSearchText(a.title)
    );
  },
  source(a: Pin, b: Pin, _deadlineOf?: DeadlineOf, sessionId?: string): number {
    return (
      compareNumbers(
        Number(b.sourceSessionId === sessionId),
        Number(a.sourceSessionId === sessionId)
      ) ||
      (a.sourceSessionId === b.sourceSessionId
        ? 0
        : a.sourceSessionId < b.sourceSessionId
          ? -1
          : 1)
    );
  },
} as const satisfies Record<PinsViewSort, PinComparator>;

export type PinSortId = keyof typeof PIN_SORTS;

/** Newest first; a time that does not parse (+∞ from `epochMs`) last. */
function compareNewest(a: number, b: number): number {
  const aKnown = Number.isFinite(a);
  const bKnown = Number.isFinite(b);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  return aKnown ? compareNumbers(b, a) : 0;
}

/** Whether a pin has a value for a sort's primary key. */
function hasSortKey(
  sort: PinsViewSort,
  pin: Pin,
  deadlineOf: DeadlineOf
): boolean {
  switch (sort) {
    case "deadline":
      return deadlineOf(pin) !== undefined;
    case "updated":
      return Number.isFinite(epochMs(pin.updatedAt));
    case "created":
      return Number.isFinite(epochMs(pin.createdAt));
    case "kind":
      return PIN_KIND_INDEX.has(pin.kind);
    default:
      return true;
  }
}

/**
 * One section's order (#6451). Open pins: starred first in both directions,
 * then the sort's key (reversed for `asc`, a pin without one last either way),
 * then C's full priority, then `key`. Under `priority` + `asc` the starred
 * term stays first and the rest of the priority order reverses. Completed
 * pins: `priority` means newest settle first ({@link compareCompleted}),
 * reversed for `asc`; any other sort falls back to it as the tie-break.
 * The result is total and stable. A sort a newer build stored and this one
 * cannot read is treated as `priority`.
 */
export function sortPins<T extends { pin: Pin }>(
  models: readonly T[],
  sort: PinsViewSort,
  dir: PinsViewDirection,
  opts: { completed: boolean; deadlineOf?: DeadlineOf; sessionId?: string }
): T[] {
  const deadlineOf = opts.deadlineOf ?? noDeadline;
  const flip = dir === "asc" ? -1 : 1;
  const primary: PinComparator | undefined = PIN_SORTS[sort];
  const compare = (a: Pin, b: Pin): number => {
    if (opts.completed) {
      if (sort === "priority" || !primary) {
        return flip * compareCompleted(a, b);
      }
    } else {
      const starred = compareNumbers(Number(b.starred), Number(a.starred));
      if (starred) return starred;
      if (sort === "priority" || !primary) {
        return dir === "asc"
          ? -comparePriorityTerms(a, b, deadlineOf) || compareKeys(a, b)
          : PIN_SORTS.priority(a, b, deadlineOf);
      }
    }
    const aHas = hasSortKey(sort, a, deadlineOf);
    const bHas = hasSortKey(sort, b, deadlineOf);
    if (aHas !== bHas) return aHas ? -1 : 1;
    const byKey = aHas ? flip * primary(a, b, deadlineOf, opts.sessionId) : 0;
    return (
      byKey ||
      (opts.completed
        ? compareCompleted(a, b)
        : PIN_SORTS.priority(a, b, deadlineOf))
    );
  };
  return [...models].sort((a, b) => compare(a.pin, b.pin));
}

/**
 * The Ledger's default view; E's toolbar default is literally this constant,
 * derived from the shared built-in the Preferences defaults fall back to.
 */
export const DEFAULT_PIN_VIEW = {
  sort: PINS_VIEW_BUILTIN.sort,
  dir: PINS_VIEW_BUILTIN.dir,
  group: PINS_VIEW_BUILTIN.group,
} as const;

/**
 * When a pin settled: the time of its answer on record, else its last update,
 * which for a withdrawn or dismissed pin is the close time. A pin answered,
 * re-opened and then dismissed sorts by the dismissal, not the old answer
 * (#6450, the Nov 7 requirement).
 */
export function settledAt(pin: Pin): string {
  return answerOnRecord(pin)?.at ?? pin.updatedAt;
}

/** Completed order: newest settle first, then `key`. */
export function compareCompleted(a: Pin, b: Pin): number {
  return (
    compareNumbers(epochMs(settledAt(b)), epochMs(settledAt(a))) ||
    compareKeys(a, b)
  );
}

// ── Display values ──────────────────────────────────────────────────────────

/** A's definition: never opened, or changed since it was last opened. */
export function isPinNew(pin: Pin): boolean {
  return pin.seenRevision === null || pin.seenRevision < pin.revision;
}

/** The recommended option first (Matt's standing rule), then authored order. */
export function orderedOptions(model: PinViewModel): PinOption[] {
  const recommended = model.pin.recommended;
  const first = model.options.find(option => option.id === recommended);
  if (!first) return model.options;
  return [first, ...model.options.filter(option => option !== first)];
}

/** The recommended option, when it is one of the pin's options. */
export function recommendedOption(model: PinViewModel): PinOption | undefined {
  const recommended = model.pin.recommended;
  return recommended
    ? model.options.find(option => option.id === recommended)
    : undefined;
}

// Every Completed value below reads the answer through `answerOnRecord`, the
// rule the server's 409 text and the agent tools use (#6448), so a pin answered,
// re-opened and then dismissed shows no answer, no note and no channel.

/** The note the operator attached to the answer on record, if any. */
export function settlingAnswerNote(pin: Pin): string | undefined {
  const note = answerOnRecord(pin)?.note;
  return note && note.trim() ? note : undefined;
}

/** A Completed row's answer cell: "A. Ship it", the free text, or "—". */
export function completedAnswerText(pin: Pin): string {
  const answer = answerOnRecord(pin);
  if (!answer) return "—";
  const text = [answer.option, answer.label ?? answer.text]
    .filter(Boolean)
    .join(". ");
  return text || "—";
}

export type CompletedReceipt = {
  label: string;
  tone: "you" | "auto" | "neutral";
  tooltip: string;
};

/**
 * Who settled a Completed pin, from its answer on record: an auto-answered pin
 * or an `auto` answer is "auto". Withdrawn, dismissed and open pins have no
 * answer on record. The receipt and E's "Completed by" facet both read this,
 * so they cannot disagree (#6451).
 */
export function pinDecidedBy(
  pin: Pin
): "operator" | "auto" | "agent" | undefined {
  if (pin.status !== "answered" && pin.status !== "auto-answered") {
    return undefined;
  }
  const by = answerOnRecord(pin)?.by;
  if (pin.status === "auto-answered" || by === "auto") return "auto";
  return by === "operator" || by === "agent" ? by : undefined;
}

/** Who completed a pin, for the Completed row's receipt pill. */
export function completedReceipt(pin: Pin): CompletedReceipt {
  if (pin.status === "withdrawn") {
    return {
      label: "Withdrawn",
      tone: "neutral",
      tooltip: "Withdrawn by the agent",
    };
  }
  if (pin.status === "dismissed") {
    return {
      label: "Dismissed",
      tone: "neutral",
      tooltip: "Dismissed without an answer",
    };
  }
  const by = pinDecidedBy(pin);
  if (by === "auto") {
    return {
      label: "Auto",
      tone: "auto",
      tooltip: "Decided automatically: the deadline passed with no answer",
    };
  }
  if (by === "operator") {
    return { label: "You", tone: "you", tooltip: "Completed by you" };
  }
  if (by === "agent") {
    return {
      label: "Agent",
      tone: "neutral",
      tooltip: "Settled by the agent",
    };
  }
  return { label: "—", tone: "neutral", tooltip: "No answer on record" };
}

const CHANNELS: Record<string, string> = {
  pins: "via pins",
  chat: "via chat",
  deadline: "deadline",
  inbox: "via inbox",
};

/** Where a pin was settled: "via pins", "via chat", "deadline", "via inbox". */
export function completedChannel(pin: Pin): string {
  const via = answerOnRecord(pin)?.via;
  if (!via) return "—";
  return CHANNELS[via] ?? `via ${via}`;
}

/** The sentence an expanded Completed pin opens with, its time in `zone`. */
export function completedSummary(pin: Pin, zone: string): string {
  const answer = answerOnRecord(pin);
  const at = formatPinTime(settledAt(pin), zone);
  const receipt = completedReceipt(pin);
  if (receipt.tone === "auto") {
    return `Decided automatically when its deadline passed, ${at}.`;
  }
  if (pin.status === "withdrawn") return `Withdrawn by the agent, ${at}.`;
  if (pin.status === "dismissed") return `Dismissed, ${at}.`;
  const where =
    answer?.via === "chat"
      ? "in the chat"
      : answer?.via === "inbox"
        ? "from the inbox"
        : "on the Pins tab";
  const who = receipt.label === "Agent" ? "the agent" : "you";
  return `Completed by ${who} ${where}, ${at}.`;
}

// ── Answering (#6450) ───────────────────────────────────────────────────────

export type MootNotice = {
  /** The revision the operator answered. */
  answered: number;
  /** The pin's revision now. */
  current: number;
  option?: string;
  label?: string;
};

/**
 * For an open pin whose newest operator answer changed nothing because the pin
 * had moved on: which revision was answered and which is current. A later
 * answer that settled or a newer answer that was not moot clears it.
 */
export function mootNotice(pin: Pin): MootNotice | undefined {
  if (pin.status !== "open") return undefined;
  for (let i = pin.answers.length - 1; i >= 0; i--) {
    const answer = pin.answers[i] as PinAnswer;
    if (answer.by !== "operator" || !answer.resolves) continue;
    if (!answer.moot) return undefined;
    return {
      answered: answer.revision,
      current: pin.revision,
      ...(answer.option !== undefined ? { option: answer.option } : {}),
      ...(answer.label !== undefined ? { label: answer.label } : {}),
    };
  }
  return undefined;
}

/** The Moot pill's tooltip and the detail's opening line. */
export function mootSentence(notice: MootNotice): string {
  const choice = notice.option
    ? `${notice.option}${notice.label ? `. ${notice.label}` : ""}`
    : "your answer";
  return `You answered ${choice} on revision ${notice.answered}; this pin is now revision ${notice.current}, so your answer changed nothing. Answer it again.`;
}

/**
 * True when a staged choice or tick was made on an older revision than the
 * pin's now; a note or a question alone is never stale (KD4).
 */
export function stagedIsStale(
  staged: Pick<StagedPin, "rev" | "choice" | "ticks"> | undefined,
  pin: Pick<Pin, "revision">
): boolean {
  if (!staged) return false;
  const answers =
    staged.choice !== undefined || (staged.ticks?.length ?? 0) > 0;
  return answers && staged.rev < pin.revision;
}

/**
 * How many steps the server has on record as done for the current revision: the
 * newest non-moot entry carrying `steps` (the count a Submit records).
 */
export function stepsSent(pin: Pin): number {
  for (let i = pin.answers.length - 1; i >= 0; i--) {
    const answer = pin.answers[i] as PinAnswer;
    if (answer.moot || answer.revision !== pin.revision) continue;
    const steps = answer.steps as { done?: unknown } | undefined;
    if (typeof steps?.done === "number") return steps.done;
  }
  return 0;
}

// ── Times ───────────────────────────────────────────────────────────────────

// Every Pins time renders in one zone (#6451 KD11, #6452): the operator's
// Time Log zone the server sends, resolved by `resolvePinZone`
// (`lib/pins/zoneTime.ts`) and carried in `PinsContext`. Built once per zone,
// because constructing an Intl.DateTimeFormat costs far more than formatting
// with one (#6208, `utils/formatMessageTimestamp.ts`).
const pinTimeFormats = new Map<string, Intl.DateTimeFormat>();

function pinTimeFormat(zone: string): Intl.DateTimeFormat {
  const cached = pinTimeFormats.get(zone);
  if (cached) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    // An unknown zone must not break a render: UTC is always known.
    format = pinTimeFormat("UTC");
  }
  pinTimeFormats.set(zone, format);
  return format;
}

/** "Nov 7, 3:58 PM" in `zone`; the raw value if it does not parse. */
export function formatPinTime(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? pinTimeFormat(zone).format(ms) : iso;
}

/** {@link formatPinTime} for an instant already in epoch ms (the timeline). */
export function formatPinInstant(ms: number, zone: string): string {
  return pinTimeFormat(zone).format(ms);
}

/** A compact age ("now", "5m", "3h", "2d"), from the Ledger's per-minute clock. */
export function formatPinAge(createdAt: string, now: number): string {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return "";
  return formatRelativeTimeCompact(ms, now) ?? "";
}
