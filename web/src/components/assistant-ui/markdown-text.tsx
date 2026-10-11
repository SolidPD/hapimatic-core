// SPDX-License-Identifier: AGPL-3.0-only
import type { ComponentPropsWithoutRef } from "react";
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import remarkGemoji from "remark-gemoji";
import { cn } from "@/lib/utils";
import {
  InlineMarkdownAnchor,
  InlineMarkdownCode,
} from "@/components/assistant-ui/sharedMarkdownComponents";
import { SyntaxHighlighter } from "@/components/assistant-ui/shiki-highlighter";
import { CopyButton } from "@/components/ui/CopyButton";
import { QUICK_REPLIES_COMPONENTS_BY_LANGUAGE } from "@/components/AssistantChat/messages/QuickReplies";
import {
  STAGE_REPORT_COMPONENTS_BY_LANGUAGE,
  STAGE_REPORT_TABLE_CLASS,
  remarkStageReport,
} from "@/components/AssistantChat/messages/StageReportCard";

export const MARKDOWN_PLUGINS = [remarkGfm, remarkGemoji];

/**
 * #3591: the merged per-language fence-override map. HOISTED to a module-level
 * constant (never an inline `{{...}}` literal in JSX) because assistant-ui's
 * `CodeOverride` is memoised on the REFERENCE equality of `componentsByLanguage`;
 * a fresh object each render would defeat the memo for every code block in every
 * message on all three MarkdownText surfaces. Exporting it also makes a later
 * MarkdownRenderer opt-in a one-liner.
 */
export const MARKDOWN_COMPONENTS_BY_LANGUAGE = {
  ...QUICK_REPLIES_COMPONENTS_BY_LANGUAGE,
  ...STAGE_REPORT_COMPONENTS_BY_LANGUAGE,
} as const;

/**
 * #3591 (R4): the DERIVED plugin list for `MarkdownText` only — `MARKDOWN_PLUGINS`
 * plus `remarkStageReport`, which suppresses a table replaced by a valid
 * stage-report card and tags a plain stage-report table otherwise. It is a NEW
 * constant, NOT an append to the shared `MARKDOWN_PLUGINS` export: that export is
 * consumed by `MarkdownRenderer.tsx` and `reasoning.tsx`, and `MarkdownRenderer`
 * passes no `componentsByLanguage`, so appending there would delete a table and
 * leave the payload as a raw JSON block — strictly worse. Keeping it derived also
 * leaves `MARKDOWN_PLUGINS` exactly `[remarkGfm, remarkGemoji]` for its tests.
 */
export const STAGE_REPORT_MARKDOWN_PLUGINS = [
  ...MARKDOWN_PLUGINS,
  remarkStageReport,
];

function CodeHeader(props: CodeHeaderProps) {
  const language =
    props.language && props.language !== "unknown" ? props.language : "";

  return (
    <div className="aui-md-codeheader flex items-center justify-between rounded-t-md bg-[var(--app-code-bg)] px-2 py-1">
      <div className="min-w-0 flex-1 pr-2 text-xs font-mono text-[var(--app-hint)]">
        {language}
      </div>
      <CopyButton text={props.code} className="shrink-0" />
    </div>
  );
}

function Pre(props: ComponentPropsWithoutRef<"pre">) {
  const { className, ...rest } = props;

  return (
    <div className="aui-md-pre-wrapper min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden">
      <pre
        {...rest}
        className={cn(
          "aui-md-pre m-0 w-max min-w-full rounded-b-md rounded-t-none bg-[var(--app-code-bg)] p-2 text-[0.75em]",
          className
        )}
      />
    </div>
  );
}

function Code(props: ComponentPropsWithoutRef<"code">) {
  const isCodeBlock = useIsMarkdownCodeBlock();

  if (isCodeBlock) {
    return (
      <code
        {...props}
        className={cn(
          "aui-md-codeblockcode font-mono text-[1em]",
          props.className
        )}
      />
    );
  }

  // Inline code shares the house styling via the leaf module (#3719); the block
  // branch + `useIsMarkdownCodeBlock` stay local.
  return <InlineMarkdownCode {...props} />;
}

// Inline anchor styling is shared via the leaf module (#3719). Kept as the local
// `A` binding so the components-map wiring (`a: A`) is unchanged.
const A = InlineMarkdownAnchor;

function Paragraph(props: ComponentPropsWithoutRef<"p">) {
  return (
    <p {...props} className={cn("aui-md-p leading-relaxed", props.className)} />
  );
}

function Blockquote(props: ComponentPropsWithoutRef<"blockquote">) {
  return (
    <blockquote
      {...props}
      className={cn(
        "aui-md-blockquote border-l-4 border-[var(--app-hint)] pl-3 opacity-85",
        props.className
      )}
    />
  );
}

function UnorderedList(props: ComponentPropsWithoutRef<"ul">) {
  return (
    <ul
      {...props}
      className={cn("aui-md-ul list-disc pl-6", props.className)}
    />
  );
}

function OrderedList(props: ComponentPropsWithoutRef<"ol">) {
  return (
    <ol
      {...props}
      className={cn("aui-md-ol list-decimal pl-6", props.className)}
    />
  );
}

function ListItem(props: ComponentPropsWithoutRef<"li">) {
  return <li {...props} className={cn("aui-md-li", props.className)} />;
}

function Hr(props: ComponentPropsWithoutRef<"hr">) {
  return (
    <hr
      {...props}
      className={cn("aui-md-hr border-[var(--app-divider)]", props.className)}
    />
  );
}

function Table(props: ComponentPropsWithoutRef<"table">) {
  const { className, ...rest } = props;
  // #3591 (R4 branch C): a stage-report table tagged by `remarkStageReport` carries
  // `data-stage-report` (flowing through `...rest` to the <table>). Style it as the
  // card via the shared STAGE_REPORT_TABLE_CLASS, whose descendant selectors reach
  // the cells the tag branch never tags — so the tag path and the fence-path card
  // share ONE styling source and cannot drift.
  const isStageReport = "data-stage-report" in rest;

  return (
    <div className="aui-md-table-wrapper max-w-full overflow-x-auto">
      <table
        {...rest}
        className={cn(
          "aui-md-table w-full border-collapse",
          isStageReport && STAGE_REPORT_TABLE_CLASS,
          className
        )}
      />
    </div>
  );
}

function Thead(props: ComponentPropsWithoutRef<"thead">) {
  return <thead {...props} className={cn("aui-md-thead", props.className)} />;
}

function Tbody(props: ComponentPropsWithoutRef<"tbody">) {
  return <tbody {...props} className={cn("aui-md-tbody", props.className)} />;
}

function Tr(props: ComponentPropsWithoutRef<"tr">) {
  return <tr {...props} className={cn("aui-md-tr", props.className)} />;
}

function Th(props: ComponentPropsWithoutRef<"th">) {
  return (
    <th
      {...props}
      className={cn(
        "aui-md-th border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-left font-semibold",
        props.className
      )}
    />
  );
}

function Td(props: ComponentPropsWithoutRef<"td">) {
  return (
    <td
      {...props}
      className={cn(
        "aui-md-td border border-[var(--app-border)] px-2 py-1",
        props.className
      )}
    />
  );
}

function H1(props: ComponentPropsWithoutRef<"h1">) {
  return (
    <h1
      {...props}
      className={cn(
        "aui-md-h1 mt-3 text-[1.14em] font-semibold",
        props.className
      )}
    />
  );
}

function H2(props: ComponentPropsWithoutRef<"h2">) {
  return (
    <h2
      {...props}
      className={cn("aui-md-h2 mt-3 text-[1em] font-semibold", props.className)}
    />
  );
}

function H3(props: ComponentPropsWithoutRef<"h3">) {
  return (
    <h3
      {...props}
      className={cn("aui-md-h3 mt-2 text-[1em] font-semibold", props.className)}
    />
  );
}

function H4(props: ComponentPropsWithoutRef<"h4">) {
  return (
    <h4
      {...props}
      className={cn("aui-md-h4 mt-2 text-[1em] font-semibold", props.className)}
    />
  );
}

function H5(props: ComponentPropsWithoutRef<"h5">) {
  return (
    <h5
      {...props}
      className={cn("aui-md-h5 mt-2 text-[1em] font-semibold", props.className)}
    />
  );
}

function H6(props: ComponentPropsWithoutRef<"h6">) {
  return (
    <h6
      {...props}
      className={cn("aui-md-h6 mt-2 text-[1em] font-semibold", props.className)}
    />
  );
}

function Strong(props: ComponentPropsWithoutRef<"strong">) {
  return (
    <strong
      {...props}
      className={cn("aui-md-strong font-semibold", props.className)}
    />
  );
}

function Em(props: ComponentPropsWithoutRef<"em">) {
  return <em {...props} className={cn("aui-md-em italic", props.className)} />;
}

function Image(props: ComponentPropsWithoutRef<"img">) {
  return (
    <img
      {...props}
      className={cn("aui-md-img max-w-full rounded", props.className)}
    />
  );
}

export const defaultComponents = memoizeMarkdownComponents({
  SyntaxHighlighter,
  CodeHeader,
  pre: Pre,
  code: Code,
  h1: H1,
  h2: H2,
  h3: H3,
  h4: H4,
  h5: H5,
  h6: H6,
  a: A,
  p: Paragraph,
  strong: Strong,
  em: Em,
  blockquote: Blockquote,
  ul: UnorderedList,
  ol: OrderedList,
  li: ListItem,
  hr: Hr,
  table: Table,
  thead: Thead,
  tbody: Tbody,
  tr: Tr,
  th: Th,
  td: Td,
  img: Image,
} as const);

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      // #3591 (R4): the DERIVED plugin list — plain MARKDOWN_PLUGINS plus
      // remarkStageReport — passed HERE only, never on the shared export.
      remarkPlugins={STAGE_REPORT_MARKDOWN_PLUGINS}
      components={defaultComponents}
      // #3333 + #3591: route both `hapi_quick_replies` and `hapi_stage_report`
      // fenced blocks through their card renderers on EVERY MarkdownText surface at
      // once (full render, narration fold, output-only-collapsed) — a single seam
      // covering all three, via the hoisted merged map. An invalid / mid-stream
      // fence falls back to a plain code block (R2 / 3333-7).
      componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
      className={cn("aui-md min-w-0 max-w-full break-words text-[1em]")}
    />
  );
}
