// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { stripAnsiAndControls } from "@/components/assistant-ui/markdown-utils";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";

const CLI_TAG_PATTERN =
  "(?:local-command-[a-z-]+|command-(?:name|message|args))";
const CLI_TAG_CHECK_REGEX = new RegExp(`<${CLI_TAG_PATTERN}>`, "i");
const CLI_TAG_REGEX_SOURCE = `<(${CLI_TAG_PATTERN})>([\\s\\S]*?)<\\/\\1>`;
const BR_REGEX = /<br\s*\/?>/gi;

const LABELS: Record<string, string> = {
  "command-name": "Command",
  "command-message": "Command message",
  "command-args": "Command args",
  "local-command-stdout": "Stdout",
  "local-command-stderr": "Stderr",
};
const COMMAND_NAME_REGEX = /<command-name>([\s\S]*?)<\/command-name>/i;

export function hasCliOutputTags(text: string): boolean {
  return CLI_TAG_CHECK_REGEX.test(text);
}

function normalizeCliText(text: string): string {
  const withoutAnsi = stripAnsiAndControls(text);
  return withoutAnsi.replace(BR_REGEX, "\n");
}

function formatLabel(tag: string): string {
  const normalized = tag.toLowerCase();
  if (LABELS[normalized]) {
    return LABELS[normalized];
  }
  return normalized.replace(/-/g, " ");
}

function buildCliOutput(text: string): string {
  const matches = Array.from(
    text.matchAll(new RegExp(CLI_TAG_REGEX_SOURCE, "gi"))
  );
  if (matches.length === 0) {
    return normalizeCliText(text);
  }

  const sections: string[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    const startIndex = match.index ?? 0;
    if (startIndex > lastIndex) {
      const before = normalizeCliText(text.slice(lastIndex, startIndex));
      if (before.trim().length > 0) {
        sections.push(before.trimEnd());
      }
    }

    const tagName = match[1] ?? "";
    const content = normalizeCliText(match[2] ?? "");
    const label = formatLabel(tagName);

    if (content.length > 0) {
      sections.push(`${label}:\n${content}`);
    } else {
      sections.push(`${label}:`);
    }

    lastIndex = startIndex + match[0].length;
  }

  if (lastIndex < text.length) {
    const tail = normalizeCliText(text.slice(lastIndex));
    if (tail.trim().length > 0) {
      sections.push(tail.trimEnd());
    }
  }

  return sections.join("\n\n");
}

function extractCommandName(text: string): string | null {
  const match = text.match(COMMAND_NAME_REGEX);
  if (!match) return null;
  const normalized = normalizeCliText(match[1] ?? "");
  const firstLine = normalized
    .split("\n")
    .find(line => line.trim().length > 0)
    ?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : null;
}

function DetailsIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
      <path
        d="M6 3l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CliIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 4.5l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 10.5h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CliOutputBlock(props: { text: string }) {
  const content = useMemo(() => buildCliOutput(props.text), [props.text]);
  const commandName = useMemo(
    () => extractCommandName(props.text),
    [props.text]
  );

  return (
    // #2991 (S4/R5): terminal (cli-output) bubbles read as visually distinct
    // within the tool category — a subtle --cat-tools left accent + a tools-tinted
    // terminal glyph (below) — while still riding the `toolRuns` preference (S1) and
    // tool-run grouping (S2). No separate preference row (epic decision). The border
    // color references var(--cat-tools) (never hex), so it survives palette swaps.
    <Card
      className="min-w-0 max-w-full overflow-hidden border-l-2 shadow-sm"
      style={{
        borderLeftColor:
          "color-mix(in srgb, var(--cat-tools) 55%, transparent)",
      }}
    >
      <CardHeader className="p-3 space-y-0">
        <Dialog>
          <DialogTrigger asChild>
            <button /* design-tokens-allow: bespoke DialogTrigger card-header focus-wrapper — a <Button> box (bg/hover/height/font-medium/rounded) would alter the bare rich header (L6 #3408) */
              type="button"
              className="w-full text-left"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    {/* #2991 (S4/R5): the terminal glyph carries the tools hue —
                        the distinct "terminal output" marker within the tool category. */}
                    <div className="shrink-0 flex h-4 w-4 items-center justify-center text-[var(--cat-tools)] leading-none">
                      <CliIcon />
                    </div>
                    <CardTitle className="min-w-0 text-sm font-medium leading-tight break-words">
                      {commandName ?? "CLI output"}
                    </CardTitle>
                  </div>
                  <span className="text-[var(--app-hint)]">
                    <DetailsIcon />
                  </span>
                </div>
              </div>
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>CLI output</DialogTitle>
              <DialogDescription className="sr-only">
                Full CLI command output.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-3 max-h-[75vh] overflow-auto">
              <div className="min-w-0 max-w-full overflow-x-auto overflow-y-hidden">
                <pre className="m-0 w-max min-w-full bg-[var(--app-code-bg)] p-2 text-xs font-mono">
                  {content}
                </pre>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
    </Card>
  );
}
