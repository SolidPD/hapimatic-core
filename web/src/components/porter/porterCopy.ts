// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Configuration Porter — shared UI copy (issue #3446, epic #3445 Sub A, K9).
 *
 * Single-sourced reassurance line rendered by A's "received" banner (this sub-
 * issue) AND D's Claude-Code-paste card (#3449), so the two surfaces — and any
 * future porter surface — never drift. Slotted at `data-testid="porter-trust-copy"`
 * on each. It states the load-bearing safety property of the whole flow: the
 * archive is definitions-only and NOTHING is written until the operator reviews
 * and commits the plan.
 */
export const PORTER_TRUST_COPY =
  "Your existing setup won't be affected — nothing is written until you review the plan.";

/**
 * Configuration Porter — the P7(a) "regular terminal, source machine" sentence
 * (issue #3449, epic #3445 Sub D). Rendered ONCE on D's instructions card. It
 * states the load-bearing where-to-run fact the friction log surfaced (P7(a),
 * `claudedocs/issue-2345-porter-friction-log.md:110`): the one-liner runs in a
 * REGULAR terminal on the machine being exported — never a Hapimatic chat. Kept
 * a single exported constant so the card asserts one referent [1B#47].
 */
export const PORTER_REGULAR_TERMINAL_COPY =
  "Run the command in a regular terminal on the machine whose configuration you're bringing over — not in a Hapimatic chat.";

/**
 * Configuration Porter — the paste-into-Claude-Code path (issue #3449 Sub D, R4,
 * D2(b)). DISTINCT from the legacy Advanced LLM-assisted prompt: this is the same
 * deterministic one-liner, pasted into a Claude Code session the user started
 * THEMSELVES in a terminal on the source machine (not a Hapimatic session) — so
 * the "no Claude/LLM step" bullet stays truthful [1B#50]. The fetch leg is
 * re-fetchable within the TTL; expiry is the only failure this names [D2(b)].
 * A single exported constant so D's card asserts one referent [1B#47].
 */
export const PORTER_CLAUDE_CODE_PATH_COPY =
  "Already running Claude Code on that machine? Paste the line into a Claude Code session you started yourself in a terminal on that machine — not a session inside Hapimatic. Claude Code just runs the same deterministic line. If the link has expired, click New link and paste again.";
