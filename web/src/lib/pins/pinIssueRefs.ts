// SPDX-License-Identifier: AGPL-3.0-only
import { findIssueRefs, resolveIssueRepo, type Pin } from "@hapi/protocol";

/** One issue a pin names, with the repository resolved. */
export type PinIssue = { repo: string; number: number };

/** Where a bare `#N` points: the session's repository, else the linked issue's. */
export type IssueRepoContext = {
  repoIdentity?: string | null;
  linkedIssueRepo?: string | null;
};

/**
 * `text` with every backtick code span blanked out, so a reference in code is
 * not counted. CommonMark's rule: a run of N backticks is closed by the next run
 * of exactly N, and an unclosed run is literal text. A fenced block is a run of
 * three or more, so it is covered too. Linear: each length's runs are walked
 * once, forward, so a context full of unmatched backticks stays cheap.
 */
export function withoutCodeSpans(text: string): string {
  const runs: { start: number; end: number }[] = [];
  for (let i = text.indexOf("`"); i >= 0; i = text.indexOf("`", i)) {
    let end = i;
    while (text.charCodeAt(end) === 0x60) end++;
    runs.push({ start: i, end });
    i = end;
  }
  if (runs.length < 2) return text;
  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const length = run.end - run.start;
    const list = byLength.get(length);
    if (list) list.push(index);
    else byLength.set(length, [index]);
  });
  const next = new Map<number, number>();
  let out = "";
  let at = 0;
  let r = 0;
  while (r < runs.length) {
    const run = runs[r];
    const length = run.end - run.start;
    const list = byLength.get(length) as number[];
    let p = next.get(length) ?? 0;
    while (p < list.length && list[p] <= r) p++;
    next.set(length, p);
    if (p >= list.length) {
      r++; // no closing run: literal backticks
      continue;
    }
    const close = runs[list[p]];
    out += `${text.slice(at, run.start)} `;
    at = close.end;
    r = list[p] + 1;
  }
  return out + text.slice(at);
}

/** Every text in a pin a reference may appear in, in reading order. */
function pinTexts(pin: Pin): string[] {
  const texts = [pin.title];
  if (pin.context) texts.push(withoutCodeSpans(pin.context));
  if (pin.rationale) texts.push(pin.rationale);
  for (const option of pin.options ?? []) {
    texts.push(option.label);
    if (option.consequence) texts.push(option.consequence);
  }
  for (const step of pin.steps ?? []) {
    texts.push(step.where);
    for (const part of step.parts) {
      const words = "text" in part ? part.text : part.label;
      if (words) texts.push(words);
    }
  }
  for (const item of pin.evidence ?? []) {
    if (item.label) texts.push(item.label);
  }
  return texts;
}

/**
 * The distinct issues a pin names anywhere (R10), in order of first mention. A
 * bare `#N` with no known repository is left out, never guessed.
 */
export function pinIssueRefs(pin: Pin, context: IssueRepoContext): PinIssue[] {
  const seen = new Set<string>();
  const issues: PinIssue[] = [];
  for (const text of pinTexts(pin)) {
    for (const ref of findIssueRefs(text)) {
      const repo = resolveIssueRepo(ref, context);
      if (repo === null) continue;
      const id = `${repo.toLowerCase()}#${ref.number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      issues.push({ repo, number: ref.number });
    }
  }
  return issues;
}
