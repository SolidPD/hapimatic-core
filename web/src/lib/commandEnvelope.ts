// SPDX-License-Identifier: AGPL-3.0-only
const NAME_REGEX = /<command-name>([\s\S]*?)<\/command-name>/;
// Greedy: an argument that itself contains "</command-args>" stays whole.
const ARGS_REGEX = /<command-args>([\s\S]*)<\/command-args>/;
const MESSAGE_REGEX = /<command-message>[\s\S]*?<\/command-message>/;

/**
 * Display text for a user turn that is a Claude Code slash-command envelope
 * (`<command-message>x</command-message><command-name>/x</command-name>
 * <command-args>…</command-args>`): returns "/x args", or `null` when the text
 * is anything other than a whole envelope, so the caller renders it verbatim.
 *
 * Deliberately narrower than the transcript list's one-line `displayTitle`: it
 * keeps the argument's newlines and markdown and never strips other tags,
 * because this is a full message body, not a title. Display-only — the stored
 * and indexed text stays verbatim.
 */
export function commandEnvelopeText(text: string): string | null {
  const name = text.match(NAME_REGEX)?.[1]?.trim();
  if (!name) return null;

  const remainder = text
    .replace(ARGS_REGEX, "")
    .replace(MESSAGE_REGEX, "")
    .replace(NAME_REGEX, "");
  if (remainder.trim() !== "") return null;

  const args = text.match(ARGS_REGEX)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}
