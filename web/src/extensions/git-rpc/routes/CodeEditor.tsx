// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState } from "react";
import CodeMirror, { EditorView, type Extension } from "@uiw/react-codemirror";
import { languages } from "@codemirror/language-data";

// issue #2964: a controlled CodeMirror 6 wrapper that replaces the V1 <textarea>
// in the VM file browser. This module is the dynamic-import boundary (see
// file.tsx's `lazy(() => import("./CodeEditor"))`), so CodeMirror stays out of
// the initial bundle and only loads on entering edit mode.

type LanguageDescriptor = (typeof languages)[number];

// A few Shiki canonical names (produced by file.tsx's resolveLanguage via
// langAlias) diverge from CodeMirror's language-data name/alias vocabulary.
// Bridge the common ones; anything unmapped still falls through to the
// name/alias/extension match below, then to plain text — never an error.
const SHIKI_TO_CM_LANGUAGE: Record<string, string> = {
  shellscript: "shell",
};

export function findLanguage(language: string): LanguageDescriptor | undefined {
  const normalized = language.toLowerCase();
  const key = SHIKI_TO_CM_LANGUAGE[normalized] ?? normalized;
  return languages.find(
    descriptor =>
      descriptor.name.toLowerCase() === key ||
      descriptor.alias.some(alias => alias.toLowerCase() === key) ||
      descriptor.extensions.some(extension => extension.toLowerCase() === key)
  );
}

// Module-level theme + static extensions so the memoized `extensions` array
// only changes when the resolved language changes. The theme matches the
// read-side look (--app-code-bg / --app-fg, --app-hint gutters).
const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--app-code-bg)",
      color: "var(--app-fg)",
      fontSize: "12px",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      caretColor: "var(--app-fg)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--app-code-bg)",
      color: "var(--app-hint)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--app-subtle-bg)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--app-subtle-bg)" },
  },
  { dark: true }
);

// Disable autocorrect / autocapitalize / spellcheck on the editing surface
// itself (mirrors the V1 <textarea> attributes) — important for code on the
// iPhone 16 virtual keyboard.
const staticExtensions: Extension[] = [
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({
    autocapitalize: "none",
    autocorrect: "off",
    spellcheck: "false",
  }),
];

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
}

export default function CodeEditor({
  value,
  onChange,
  language,
}: CodeEditorProps) {
  // @codemirror/language-data loads each grammar as its own dynamic-import
  // chunk, so resolve the language extension asynchronously and render plain
  // text until (and unless) it arrives.
  const [languageExtension, setLanguageExtension] = useState<Extension | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    setLanguageExtension(null);
    if (!language) return;
    const descriptor = findLanguage(language);
    if (!descriptor) return;
    descriptor
      .load()
      .then(support => {
        if (!cancelled) setLanguageExtension(support);
      })
      .catch(() => {
        // Unknown or failed grammar → stay on plain text, never throw.
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const extensions = useMemo<Extension[]>(
    () =>
      languageExtension
        ? [...staticExtensions, languageExtension]
        : staticExtensions,
    [languageExtension]
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      height="60vh"
      theme={editorTheme}
      extensions={extensions}
      basicSetup={{ foldGutter: false }}
      className="rounded-md border border-[var(--app-border)] text-xs"
    />
  );
}
