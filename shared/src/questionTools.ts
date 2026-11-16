// SPDX-License-Identifier: AGPL-3.0-only
// The tools that ask the operator a question rather than request a permission
// (issue #6455). A pending request for one of them is answered with `answers`,
// not approved or denied, so the push notifier and the Pins prompt mirror both
// need to tell the two apart, and must agree. Claude Code names the tool
// `AskUserQuestion`; the Codex and ACP adapters use `ask_user_question`. An
// MCP server's form or link request (`mcp_elicitation`, #6606) is answered on
// its own card and is a question too, so no Allow button is ever bound to it.

import { MCP_ELICITATION_TOOL } from "./elicitation";

export const QUESTION_TOOL_NAMES = [
  "AskUserQuestion",
  "ask_user_question",
  MCP_ELICITATION_TOOL,
] as const;

const QUESTION_TOOLS: ReadonlySet<string> = new Set(QUESTION_TOOL_NAMES);

/** True for a tool whose request asks the operator a question. */
export function isQuestionToolName(name: string): boolean {
  return QUESTION_TOOLS.has(name);
}
