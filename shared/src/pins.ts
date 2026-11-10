// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { isUnsafePathSegment } from "./capabilityCatalog/pathSegment";
import { addLaneIssues, PinLanesSchema } from "./pinDashboard";
import { canonicalJson, utf8ByteLength } from "./throughput";

// Pins: every decision a session needs from the operator, as a typed record
// (issue #6447, epic #6446; design of record: docs/design/pins/design-brief.md).
// This module is the SINGLE cross-package contract for a pin — the SQLite store,
// the three route surfaces, the agent tools and the Pins tab all validate against
// it, so a later sub-issue adds its fields here rather than growing its own shape.
//
// ## Input is strict, records are loose
//
// What an agent sends is strict: `.passthrough()` would keep a posted `status`,
// Zod's default strip would silently lose a misspelled `consequences`, and a
// stray `tick` field would bump the revision on every loop tick. Every rejection
// names the key, so the agent can correct it. What the server returns is loose,
// because a newer peer's added field must survive a hub and an older web client.
//
// ## The key is one safe segment
//
// `/` is refused because the typed MCP tool layer refuses it in a path segment,
// so a slash key could never be updated. A key is one safe path segment, but not a
// safe folder name on every disk (`:` and reserved names on Windows, case on a
// case-insensitive disk), so a pin's files go in `pinFolderName(key)`
// (`shared/src/pinFiles.ts`, #6453).

/** The one line #6458 flips to turn Pins on. */
export const PINS_DEFAULT_ENABLED = false;

export const PIN_KINDS = [
  "decision",
  "steps",
  "variants",
  "review",
  "dashboard",
  "detected",
] as const;
export const PIN_STAKES = ["reversible", "costly", "irreversible"] as const;
export const PIN_RISKS = ["low", "medium", "high"] as const;
/**
 * `open` needs the operator and counts toward the badge. `live` is a dashboard,
 * which is never answered and never counts. The rest are closed.
 */
export const PIN_STATUSES = [
  "open",
  "live",
  "answered",
  "auto-answered",
  "withdrawn",
  "dismissed",
] as const;
export const PIN_CHANGES = [
  "created",
  "updated",
  "answered",
  "withdrawn",
  "dismissed",
  "starred",
  // #6452: an automatic pick moved, turned off or on, or rescheduled after a
  // late deadline. Never a content change, so the revision does not move.
  "rescheduled",
  /** "Save to session folder" copied the pin's files (#6453). */
  "saved",
] as const;
export const PIN_ANSWER_BY = ["operator", "agent", "auto"] as const;
/**
 * The kinds an automatic pick may decide (#6452, ruling D4): the ones the
 * operator answers by choosing an option. An automatic "answer" to a steps or
 * review pin would close it with the work undone.
 */
export const PIN_AUTO_PICK_KINDS = ["decision", "variants"] as const;
/** Who set a pin's running automatic pick, or `off` when the operator stopped it (#6452). */
export const PIN_DEADLINE_BY = ["agent", "operator", "off"] as const;
export type PinDeadlineBy = (typeof PIN_DEADLINE_BY)[number];

export type PinKind = (typeof PIN_KINDS)[number];
export type PinStakes = (typeof PIN_STAKES)[number];
export type PinRisk = (typeof PIN_RISKS)[number];
export type PinStatus = (typeof PIN_STATUSES)[number];
export type PinChange = (typeof PIN_CHANGES)[number];
export type PinAnswerBy = (typeof PIN_ANSWER_BY)[number];

/** Canonical JSON of a pin's content, in UTF-8 bytes. */
export const PIN_CONTENT_MAX_BYTES = 32 * 1024;
/** A write request, refused before parsing. Leaves room for JSON whitespace. */
export const PIN_REQUEST_MAX_BYTES = 64 * 1024;
export const PIN_MAX_OPEN_PER_SESSION = 100;
export const PIN_MAX_PER_SESSION = 500;
export const PIN_MAX_ANSWERS = 20;
/** A pin's whole history, which the content cap does not cover. */
export const PIN_ANSWERS_MAX_BYTES = 8 * 1024;
/**
 * An answer's note. The store clamps to it after cleaning (#6450), because
 * neutralizing an approval token lengthens the text and every read checks it.
 */
export const PIN_ANSWER_NOTE_MAX_CHARS = 2048;
export const PIN_LIST_DEFAULT_LIMIT = 200;
export const PIN_LIST_MAX_LIMIT = 500;
/** Server-created pins only (#6455), so an agent cannot overwrite or withdraw one. */
export const PIN_RESERVED_KEY_PREFIXES = ["prompt:", "detected:"] as const;

const PIN_TEXT_MAX_CHARS = 16 * 1024;

/**
 * An approval token, as the server's acceptor matches it
 * (`USER_APPROVAL_ACCEPT_REGEX`, server/src/services/approvalTokens.ts): unanchored,
 * so it is found anywhere in a text. Kept equal by
 * `server/src/sync/pinSubmission.test.ts`.
 */
export const APPROVAL_TOKEN_PATTERN = /USER-APPROVAL-[A-Z2-9]{4}-[A-Z2-9]{4}/;

export const PinKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,199}$/,
    "must be 1 to 200 characters of letters, digits, '.', '_', ':' or '-', starting with a letter, digit or '_'; a '/' is not allowed, so write pm26:release-go"
  )
  .refine(key => !isUnsafePathSegment(key), "must not contain '..'")
  // #6450: the key reaches the operator's Submit message verbatim, and the approval
  // hook accepts a token anywhere in a user message, so a key carrying the agent's
  // own pending token would mint its approval. Pins never carry approvals.
  .refine(
    key => !APPROVAL_TOKEN_PATTERN.test(key),
    "must not contain an approval token (USER-APPROVAL-…)"
  );

/** True for a key only the server may create, withdraw, or resolve (#6455). */
export function isReservedPinKey(key: string): boolean {
  return PIN_RESERVED_KEY_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Only `http:` and `https:`, because a `javascript:` link rendered on the PWA origin could read the login token. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A path below the session's working directory, such as `GeneratedFiles/x.png`.
 * Refused now rather than where it is read, because a stored value outlives a later
 * tightening. `%` goes too, because a reader that decodes it would see `%2e%2e`.
 */
function isWorkingTreePath(path: string): boolean {
  return (
    !/^(?:\/|~|[A-Za-z]:)|[\\%]|\p{Cc}/u.test(path) &&
    !path.split("/").includes("..")
  );
}

const PinLinkSchema = z
  .string()
  .max(2048)
  .refine(isHttpUrl, "must be an http or https URL");

export const PinEvidenceSchema = z.strictObject({
  type: z.enum(["image", "diff", "page"]),
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      isWorkingTreePath,
      "must be a relative path below the session's working directory, such as GeneratedFiles/x.png"
    ),
  label: z.string().max(200).optional(),
});
export type PinEvidence = z.infer<typeof PinEvidenceSchema>;

export const PinOptionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  consequence: z.string().max(1000).optional(),
});
export type PinOption = z.infer<typeof PinOptionSchema>;

/** One run of a step: plain words, a real link, or a tap-to-copy value. */
export const PinStepPartSchema = z.union([
  z.strictObject({ text: z.string().min(1).max(1000) }),
  z.strictObject({ link: PinLinkSchema, label: z.string().min(1).max(200) }),
  z.strictObject({
    copy: z.string().min(1).max(2000),
    label: z.string().max(200).optional(),
  }),
]);
export type PinStepPart = z.infer<typeof PinStepPartSchema>;

export const PinStepSchema = z.strictObject({
  id: z.string().min(1).max(64),
  where: z.string().min(1).max(200),
  parts: z.array(PinStepPartSchema).min(1).max(10),
});
export type PinStep = z.infer<typeof PinStepSchema>;

/**
 * An `ifUnanswered.after` duration (`PT4H`, `P1DT2H`) in milliseconds. The
 * schema below admits only days, hours and minutes, so those are all it reads.
 * The server arms a deadline with this (#6452), so the schema and the store
 * cannot disagree about how long a duration is.
 */
export function pinDeadlineAfterMs(after: string): number {
  const part = (unit: string): number =>
    Number(new RegExp(`(\\d+)${unit}`).exec(after)?.[1] ?? 0);
  const minutes = part("D") * 1440 + part("H") * 60 + part("M");
  return minutes * 60_000;
}

/** A zero duration would let an automatic pick fire before anyone could answer. */
function isPlausibleDeadline(after: string): boolean {
  const ms = pinDeadlineAfterMs(after);
  return ms > 0 && ms <= 365 * 86_400_000;
}

/** An operator's deadline must be at least this far ahead (#6452). */
export const PIN_DEADLINE_MIN_LEAD_MS = 60_000;
/** ... and at most this far ahead, matching the longest `after`. */
export const PIN_DEADLINE_MAX_AHEAD_MS = 365 * 86_400_000;
/**
 * A pick that comes due more than this late (an outage, an inactive session,
 * Pins switched off) is rescheduled instead of fired (#6452, ruling D2) ...
 */
export const PIN_DEADLINE_LATE_GRACE_MS = 3_600_000;
/** ... to this far ahead, so the operator sees it before it fires. */
export const PIN_DEADLINE_LATE_NOTICE_MS = 900_000;

export const PinIfUnansweredSchema = z.strictObject({
  option: z.string().min(1).max(64),
  // A duration, not an instant: an agent computing `now + 4h` on each loop tick
  // would change the content, bump the revision, and push the deadline forever.
  // #6452 derives the instant from it when the pick is set. After that an
  // agent revision can only move it later, a re-raise or a late pick re-arms
  // it from now, and a re-post that changes nothing leaves it alone.
  after: z
    .string()
    .regex(
      /^P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?)?$/,
      "must be an ISO-8601 duration such as PT4H or P1DT2H"
    )
    .refine(isPlausibleDeadline, "must be longer than zero and at most a year"),
});
export type PinIfUnanswered = z.infer<typeof PinIfUnansweredSchema>;

/**
 * What an agent authors, with no cross-field rules. Kept separate from
 * {@link PinContentSchema} because Zod's `.pick`/`.omit`/`.partial` handling of a
 * refined object varies by version.
 *
 * A field added here later must be optional with no `.default()`, because a default
 * changes the canonical JSON of every stored row: an identical re-post would then
 * bump an open pin's revision and earn an answered pin a 409.
 */
export const PinContentObjectSchema = z.strictObject({
  key: PinKeySchema,
  kind: z.enum(PIN_KINDS),
  title: z.string().min(1).max(200),
  /** Markdown. */
  context: z.string().max(PIN_TEXT_MAX_CHARS).optional(),
  evidence: z.array(PinEvidenceSchema).max(20).optional(),
  options: z.array(PinOptionSchema).max(12).optional(),
  steps: z.array(PinStepSchema).max(30).optional(),
  recommended: z.string().min(1).max(64).optional(),
  rationale: z.string().max(2000).optional(),
  // Required with no default: a pin that omitted them must never read as the
  // reversible, low-risk pin an automatic pick is allowed on.
  stakes: z.enum(PIN_STAKES),
  risk: z.enum(PIN_RISKS),
  blocking: z.boolean().default(false),
  ifUnanswered: PinIfUnansweredSchema.optional(),
  /**
   * A Project Manager's lanes, on a `dashboard` pin only (#6454). Optional with no
   * default, so a pin stored before #6454 keeps its canonical JSON and revision.
   * The contract and its producer are in `./pinDashboard`.
   */
  lanes: PinLanesSchema.optional(),
  /** Required on every pin, for any surface that cannot render it. */
  plainText: z
    .string()
    .max(PIN_TEXT_MAX_CHARS)
    .refine(text => text.trim().length > 0, "must not be blank"),
});
export type PinContent = z.infer<typeof PinContentObjectSchema>;

/** The fields the automatic-pick rule reads. */
export type AutoPickFields = Pick<
  PinContent,
  "kind" | "stakes" | "risk" | "options" | "ifUnanswered"
>;

/** Whether a kind may carry an automatic pick (#6452, ruling D4). */
export function isAutoPickKind(kind: string): boolean {
  return (PIN_AUTO_PICK_KINDS as readonly string[]).includes(kind);
}

/**
 * The safety boundary for automatic picks (#6452): a decision or variants pin,
 * reversible, low risk, whose named option exists. The schema rule, the
 * deadline route and the scheduler's fire-time re-check all call this, so the
 * three cannot disagree. Typed loosely enough to take a stored record, because
 * the scheduler re-checks content that may have been written by an older build.
 */
export function isAutoPickEligible(pin: AutoPickFields): boolean {
  const pick = pin.ifUnanswered;
  if (!pick) return false;
  return (
    isAutoPickKind(pin.kind) &&
    pin.stakes === "reversible" &&
    pin.risk === "low" &&
    (pin.options ?? []).some(option => option.id === pick.option)
  );
}

function addDuplicateIdIssues(
  ids: readonly string[],
  path: string,
  ctx: z.RefinementCtx
): void {
  const seen = new Set<string>();
  ids.forEach((id, index) => {
    if (seen.has(id)) {
      ctx.addIssue({
        code: "custom",
        path: [path, index, "id"],
        message: `duplicate id "${id}"`,
      });
    }
    seen.add(id);
  });
}

/** The content object plus its cross-field rules. */
export const PinContentSchema = PinContentObjectSchema.superRefine(
  (pin, ctx) => {
    addDuplicateIdIssues(
      (pin.options ?? []).map(o => o.id),
      "options",
      ctx
    );
    addDuplicateIdIssues(
      (pin.steps ?? []).map(s => s.id),
      "steps",
      ctx
    );

    const optionIds = new Set((pin.options ?? []).map(o => o.id));
    if (pin.recommended !== undefined && !optionIds.has(pin.recommended)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommended"],
        message: `must name an option id, but no option is "${pin.recommended}"`,
      });
    }
    if (pin.ifUnanswered && !optionIds.has(pin.ifUnanswered.option)) {
      ctx.addIssue({
        code: "custom",
        path: ["ifUnanswered", "option"],
        message: `must name an option id, but no option is "${pin.ifUnanswered.option}"`,
      });
    }
    // The safety boundary for automatic picks: a hole here lets a costly or
    // irreversible decision be made with no one asked (#6452). The same rule as
    // `isAutoPickEligible`, split so each failure names its reason.
    if (
      pin.ifUnanswered &&
      (pin.stakes !== "reversible" || pin.risk !== "low")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ifUnanswered"],
        message: "automatic picks are for reversible, low-risk pins only",
      });
    }
    if (pin.ifUnanswered && !isAutoPickKind(pin.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["ifUnanswered"],
        message: `automatic picks are for ${PIN_AUTO_PICK_KINDS.join(" or ")} pins only`,
      });
    }
    if (pin.lanes !== undefined && pin.kind !== "dashboard") {
      ctx.addIssue({
        code: "custom",
        path: ["lanes"],
        message: 'lanes are for a pin of kind "dashboard"',
      });
    }
    addLaneIssues(pin.lanes, ctx);
    if (pin.kind === "steps" && !pin.steps?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: 'a pin of kind "steps" must carry at least one step',
      });
    }
    if (utf8ByteLength(canonicalJson(pin)) > PIN_CONTENT_MAX_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `content is over the ${PIN_CONTENT_MAX_BYTES}-byte limit`,
      });
    }
  }
);

/** {@link PinContentSchema} plus what only the server may create. */
const AgentPinContentSchema = PinContentSchema.superRefine((pin, ctx) => {
  if (pin.kind === "detected") {
    ctx.addIssue({
      code: "custom",
      path: ["kind"],
      message: 'only the server creates a pin of kind "detected"',
    });
  }
  if (isReservedPinKey(pin.key)) {
    ctx.addIssue({
      code: "custom",
      path: ["key"],
      message: `keys starting ${PIN_RESERVED_KEY_PREFIXES.join(" or ")} are reserved for the server`,
    });
  }
});

/** The schema an agent's post goes through, on the CLI and federation surfaces. */
export function parseAgentPin(
  input: unknown
): z.ZodSafeParseResult<z.infer<typeof AgentPinContentSchema>> {
  return AgentPinContentSchema.safeParse(input);
}

/** One line naming each field, because a federation proxy keeps only the `error` string. */
export function describePinIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export type PinUpsertParse =
  | { ok: true; content: PinContent; reopen: boolean }
  | { ok: false; error: string };

/**
 * Parse an agent's `PUT .../pins/:key` body, shared by the CLI route and the
 * federation receiver. The key comes from the path, so a body key may only repeat
 * it. `reopen` is a request flag, not content, so it never bumps the revision.
 */
export function parsePinUpsert(key: string, body: unknown): PinUpsertParse {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid pin: the body must be a JSON object" };
  }
  const { reopen, ...fields } = body as Record<string, unknown>;
  if (reopen !== undefined && typeof reopen !== "boolean") {
    return { ok: false, error: "Invalid pin: reopen: must be a boolean" };
  }
  if (fields.key !== undefined && fields.key !== key) {
    return {
      ok: false,
      // Never interpolate it: `String()` throws on a hostile object or a deep array.
      error: `Invalid pin: key: does not match the path's "${key}"`,
    };
  }
  const parsed = parseAgentPin({ ...fields, key });
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid pin: ${describePinIssues(parsed.error)}`,
    };
  }
  return { ok: true, content: parsed.data, reopen: reopen === true };
}

/** The anchor of the chat message that posted a pin, the bookmark anchor's shape. */
export const PinAnchorSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    blockId: z.string().min(1).max(200).nullable(),
    offsetPx: z.number().nonnegative(),
    anchorHeightPx: z.number().int().nonnegative().nullable(),
  })
  .loose();
export type PinAnchor = z.infer<typeof PinAnchorSchema>;

/** One entry in a pin's answer history. */
export const PinAnswerSchema = z
  .object({
    /** The revision this answer was made against. */
    revision: z.number().int(),
    /** ISO-8601 UTC. */
    at: z.string(),
    /** A plain string, because a record may come from a newer peer. */
    by: z.string(),
    /** Where it was made: `pins`, `chat`, `deadline`, or `inbox`. */
    via: z.string().max(40),
    option: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    note: z.string().max(PIN_ANSWER_NOTE_MAX_CHARS).optional(),
    /** False for a question-first entry, which leaves the pin open. */
    resolves: z.boolean(),
    /** Made against any revision but the current one, or on a closed pin; it changed no status. */
    moot: z.boolean(),
    /**
     * The session the answer's message went to when it was not this pin's own
     * session: its Project Manager, because this session was not running (#6454).
     */
    deliveredTo: z.string().max(200).optional(),
  })
  .loose();
export type PinAnswer = z.infer<typeof PinAnswerSchema>;

/** The answer that settled a pin, if one did: the last that resolved and was not moot. */
export function settlingAnswer(
  answers: readonly PinAnswer[]
): PinAnswer | undefined {
  for (let i = answers.length - 1; i >= 0; i--) {
    const answer = answers[i];
    if (answer?.resolves && !answer.moot) return answer;
  }
  return undefined;
}

/**
 * The answer a closed pin may quote back to the agent that re-posted it (#6448):
 * the settling answer, only for an `answered` or `auto-answered` pin, and only
 * when it answered the pin's current revision. A pin answered, re-opened and then
 * dismissed has no answer on record, and quoting the old one would tell the agent
 * a question it re-asked was decided. The server's 409 text and the agent tools
 * both use this, so they cannot disagree.
 */
export function answerOnRecord(
  pin: Pick<Pin, "status" | "revision" | "answers">
): PinAnswer | undefined {
  if (pin.status !== "answered" && pin.status !== "auto-answered") {
    return undefined;
  }
  const settled = settlingAnswer(pin.answers);
  return settled?.revision === pin.revision ? settled : undefined;
}

/** A pin as the server returns it: the content plus everything the server owns. */
export type Pin = PinContent & {
  sessionId: string;
  /** The session that asked. Always `sessionId`, because writes go to the owner. */
  sourceSessionId: string;
  revision: number;
  status: PinStatus;
  starred: boolean;
  /** ISO-8601 UTC, or null when never opened. */
  seenAt: string | null;
  /** New or changed is exactly `seenRevision === null || seenRevision < revision`. */
  seenRevision: number | null;
  /** The session's latest message seq when the pin was first posted (#6453). */
  postedSeq: number | null;
  anchor: PinAnchor | null;
  answers: PinAnswer[];
  /**
   * #6453: the `GeneratedFiles/pins/<folder>/` the operator's last Save copied
   * into, the revision it saved, and whether the agent has yet to hear about it.
   * Server-owned like `starred`: a save never moves `updatedAt`. Optional because
   * a peer older than G omits them, and `PinSchema`'s cast would otherwise claim
   * a value an older peer never sent; read a missing value as null / false.
   */
  savedTo?: string | null;
  savedRevision?: number | null;
  saveReportPending?: boolean;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC. Moves on a content or status change, not on a star or a mark-seen. */
  updatedAt: string;
  /**
   * When the automatic pick fires (#6452), ISO-8601 UTC; null when the pin has
   * no running pick (none named, turned off, or the pin is closed). Absent from a
   * node that predates #6452, which cannot fire one: read absent as "unsupported",
   * never as "off".
   */
  deadlineAt?: string | null;
  /** Who set the running pick, or `off` when the operator turned it off (#6452). */
  deadlineBy?: PinDeadlineBy | null;
  /** The operator changed the pick since a Submit last told the agent (#6452, ruling D5). */
  deadlineReportPending?: boolean;
};

/** Loose on purpose: see the header. Enum fields are plain strings for the same reason. */
export const PinSchema = z
  .object({
    key: z.string(),
    kind: z.string(),
    title: z.string(),
    plainText: z.string(),
    stakes: z.string(),
    risk: z.string(),
    blocking: z.boolean(),
    sessionId: z.string(),
    sourceSessionId: z.string(),
    revision: z.number().int(),
    status: z.string(),
    starred: z.boolean(),
    seenAt: z.string().nullable(),
    seenRevision: z.number().int().nullable(),
    postedSeq: z.number().int().nullable(),
    anchor: PinAnchorSchema.nullable(),
    answers: z.array(PinAnswerSchema),
    // #6453: optional, because a peer older than G omits them.
    savedTo: z.string().nullable().optional(),
    savedRevision: z.number().int().nullable().optional(),
    saveReportPending: z.boolean().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deadlineAt: z.string().nullable().optional(),
    deadlineBy: z.string().nullable().optional(),
    deadlineReportPending: z.boolean().optional(),
  })
  .loose() as unknown as z.ZodType<Pin>;

export const PinResolveRequestSchema = z
  .strictObject({
    revision: z.number().int().positive().optional(),
    option: z.string().min(1).max(64).optional(),
    text: z.string().min(1).max(4000).optional(),
    note: z.string().max(PIN_ANSWER_NOTE_MAX_CHARS).optional(),
  })
  .refine(
    body => body.option !== undefined || body.text !== undefined,
    "must carry option or text"
  );
export type PinResolveRequest = z.infer<typeof PinResolveRequestSchema>;

export const PinStarRequestSchema = z.strictObject({ starred: z.boolean() });

/**
 * `PUT .../pins/:key/deadline` (#6452): move the automatic pick to an instant
 * (with an offset, so no zone is assumed) or turn it off. Turning a stopped
 * pick back on is a move. Only the operator sends this.
 */
export const PinDeadlineRequestSchema = z.union([
  z.strictObject({ at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ off: z.literal(true) }),
]);
export type PinDeadlineRequest = z.infer<typeof PinDeadlineRequestSchema>;

/** `?status=&limit=` on the list routes. */
export const PinListQuerySchema = z.object({
  status: z.enum(PIN_STATUSES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PIN_LIST_MAX_LIMIT)
    .default(PIN_LIST_DEFAULT_LIMIT),
});
export type PinListQuery = z.infer<typeof PinListQuerySchema>;

/** `GET .../pins`. `peerUnsupported`: the owning node has no pin routes. */
export const PinListResponseSchema = z
  .object({
    pins: z.array(PinSchema),
    openPinCount: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    peerUnsupported: z.boolean().optional(),
    /**
     * The operator's Time Log zone on the session's node, or null when none is
     * set (#6452). The client falls back to the browser's zone, as the server's
     * Submit summary does. Absent from a node that predates #6452.
     */
    timeZone: z.string().nullable().optional(),
  })
  .loose();
export type PinListResponse = z.infer<typeof PinListResponseSchema>;

/** `GET .../pins/:key`. */
export const PinGetResponseSchema = z
  .object({
    pin: PinSchema,
    openPinCount: z.number().int().nonnegative(),
    /** As on the list (#6452): a chat card reads one pin, not the list. */
    timeZone: z.string().nullable().optional(),
  })
  .loose();
export type PinGetResponse = z.infer<typeof PinGetResponseSchema>;

/**
 * Every pin write. `changed` is false for a no-op. A resolve also carries
 * `moot`: true when the answer was recorded in the history but changed nothing,
 * because the pin was no longer open or the answer named another revision.
 */
export const PinMutationResponseSchema = z
  .object({
    pin: PinSchema,
    openPinCount: z.number().int().nonnegative(),
    changed: z.boolean(),
    moot: z.boolean().optional(),
  })
  .loose();
export type PinMutationResponse = z.infer<typeof PinMutationResponseSchema>;
