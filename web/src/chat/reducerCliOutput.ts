// SPDX-License-Identifier: AGPL-3.0-only
import type { ChatBlock, CliOutputBlock } from "@/chat/types";

const CLI_TAG_REGEX =
  /<(?:local-command-[a-z-]+|command-(?:name|message|args))>/i;
const CLI_COMMAND_NAME_REGEX = /<command-name>/i;
const CLI_COMMAND_STDOUT_REGEX = /<local-command-stdout>/i;

function getMetaSentFrom(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const sentFrom = (meta as { sentFrom?: unknown }).sentFrom;
  return typeof sentFrom === "string" ? sentFrom : null;
}

function hasCliOutputTags(text: string): boolean {
  return CLI_TAG_REGEX.test(text);
}

function hasCommandNameTag(text: string): boolean {
  return CLI_COMMAND_NAME_REGEX.test(text);
}

function hasLocalCommandStdoutTag(text: string): boolean {
  return CLI_COMMAND_STDOUT_REGEX.test(text);
}

export function isCliOutputText(text: string, meta: unknown): boolean {
  return getMetaSentFrom(meta) === "cli" && hasCliOutputTags(text);
}

const LOCAL_COMMAND_OUTPUT_HEAD_REGEX =
  /^\s*<(local-command-(?:stdout|stderr))>/i;
const LOCAL_COMMAND_OUTPUT_TAIL_REGEX =
  /<\/(local-command-(?:stdout|stderr))>\s*$/i;
const LOCAL_COMMAND_OUTPUT_SWITCH_REGEX: Record<string, RegExp> = {
  "local-command-stdout": /<\/local-command-stdout>\s*<local-command-stderr>/i,
  "local-command-stderr": /<\/local-command-stderr>\s*<local-command-stdout>/i,
};

/**
 * Whole-envelope guard: true only when `text` is made ENTIRELY of one or more
 * `<local-command-stdout>` / `<local-command-stderr>` envelopes (allowing
 * surrounding and inter-envelope whitespace) — the shape the transcript reader
 * uses to re-supply the `sentFrom:"cli"` the server adapter drops from a string
 * user entry (#4149, Task 2). An entry that wrote to BOTH streams matches. A tag
 * merely quoted mid-prose, a `<command-name>` envelope (#4044's command bubble,
 * handled separately in `web/src/lib/commandEnvelope.ts`), or empty text all
 * return false, so no other user text is ever stamped (#4149, R2/R3).
 *
 * Envelope bodies are arbitrary text, so "splits into envelopes" reduces to
 * three linear checks: the text opens with `<X>`, closes with `</Y>`, and — when
 * X and Y differ — contains at least one `</X>`, optional whitespace, then `<Y>`
 * (a point where the run switches from X to Y; an alternating run has several,
 * one is enough). A body may contain a literal closing tag (e.g. `!cat` of a
 * file that prints one), and such an entry still matches. The extra
 * `tail.index < head[0].length` test is a defensive ordering guard: the tail
 * starts with `</`, which cannot occur inside the head, so it never fires today.
 *
 * This replaced `^\s*(?:<(…)>[\s\S]*?<\/\1>\s*)+$`, whose repeated lazy body
 * could end at any inner closing tag of its own type, so a failing entry of n
 * same-type envelopes made the engine try ~2^n splits and froze the tab
 * (#4526). A tempered body such as `(?:(?!<\/\1>)[\s\S])*` would also be linear
 * but rejects a body containing its own closing tag, changing classifications
 * this check keeps.
 */
export function isLocalCommandOutputText(text: string): boolean {
  const head = text.match(LOCAL_COMMAND_OUTPUT_HEAD_REGEX);
  const tail = text.match(LOCAL_COMMAND_OUTPUT_TAIL_REGEX);
  if (!head || !tail || (tail.index ?? 0) < head[0].length) return false;
  const open = head[1].toLowerCase();
  const close = tail[1].toLowerCase();
  return open === close || LOCAL_COMMAND_OUTPUT_SWITCH_REGEX[open].test(text);
}

export function createCliOutputBlock(props: {
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  source: CliOutputBlock["source"];
  meta?: unknown;
}): CliOutputBlock {
  return {
    kind: "cli-output",
    id: props.id,
    localId: props.localId,
    createdAt: props.createdAt,
    text: props.text,
    source: props.source,
    meta: props.meta,
  };
}

export function mergeCliOutputBlocks(blocks: ChatBlock[]): ChatBlock[] {
  const merged: ChatBlock[] = [];

  for (const block of blocks) {
    if (block.kind !== "cli-output") {
      merged.push(block);
      continue;
    }

    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === "cli-output" &&
      prev.source === block.source &&
      hasCommandNameTag(prev.text) &&
      !hasLocalCommandStdoutTag(prev.text) &&
      hasLocalCommandStdoutTag(block.text)
    ) {
      const separator =
        prev.text.endsWith("\n") || block.text.startsWith("\n") ? "" : "\n";
      merged[merged.length - 1] = {
        ...prev,
        text: `${prev.text}${separator}${block.text}`,
      };
      continue;
    }

    merged.push(block);
  }

  return merged;
}
