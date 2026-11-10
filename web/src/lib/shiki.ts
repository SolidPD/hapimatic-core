// SPDX-License-Identifier: AGPL-3.0-only
import type { HighlighterCore, LanguageInput, ThemeInput } from "shiki/core";
import { useState, useEffect, useMemo, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";

// #3098: shiki loads when the first code block highlights, not when this module
// loads. That covers the engine (a static import before, so it sat in the main
// bundle) and the two themes and 29 grammars (a module-level `import()` array,
// so their ~1.5 MB of chunks were fetched and evaluated at every app start).
// (toJsxRuntime stays static: react-markdown already puts it in the main
// bundle.)

// Only 2 themes
const loadThemes = (): ThemeInput[] => [
  import("@shikijs/themes/github-light"),
  import("@shikijs/themes/github-dark"),
];

// 29 common languages for LLM code output
const loadLangs = (): LanguageInput[] => [
  // Shell
  import("@shikijs/langs/shellscript"),
  import("@shikijs/langs/powershell"),
  // Data formats
  import("@shikijs/langs/json"),
  import("@shikijs/langs/yaml"),
  import("@shikijs/langs/toml"),
  import("@shikijs/langs/xml"),
  import("@shikijs/langs/ini"),
  // Markup
  import("@shikijs/langs/markdown"),
  import("@shikijs/langs/html"),
  import("@shikijs/langs/css"),
  import("@shikijs/langs/scss"),
  // JavaScript ecosystem
  import("@shikijs/langs/javascript"),
  import("@shikijs/langs/typescript"),
  import("@shikijs/langs/jsx"),
  import("@shikijs/langs/tsx"),
  // Query languages
  import("@shikijs/langs/sql"),
  import("@shikijs/langs/graphql"),
  // Systems languages
  import("@shikijs/langs/c"),
  import("@shikijs/langs/rust"),
  import("@shikijs/langs/go"),
  // JVM
  import("@shikijs/langs/java"),
  import("@shikijs/langs/kotlin"),
  // Scripting
  import("@shikijs/langs/python"),
  import("@shikijs/langs/php"),
  // Apple
  import("@shikijs/langs/swift"),
  // .NET
  import("@shikijs/langs/csharp"),
  // DevOps
  import("@shikijs/langs/dockerfile"),
  import("@shikijs/langs/make"),
  // Misc
  import("@shikijs/langs/diff"),
];

export const SHIKI_THEMES = {
  light: "github-light",
  dark: "github-dark",
} as const;

// Alias common code fence language names to canonical names
export const langAlias: Record<string, string> = {
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  ps1: "powershell",
  js: "javascript",
  ts: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  pgsql: "sql",
  mysql: "sql",
  postgres: "sql",
  gql: "graphql",
  py: "python",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  makefile: "make",
};

// Singleton highlighter instance
let highlighterPromise: Promise<HighlighterCore> | null = null;

async function createHighlighter(): Promise<HighlighterCore> {
  // Start the themes and grammars together with the engine (one wait, not two).
  const themes = loadThemes();
  const langs = loadLangs();
  // If the engine fails to load, these are never handed to shiki: settle them
  // here so a failure among them is not reported as an unhandled rejection.
  void Promise.allSettled([...themes, ...langs]);
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
    await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
  return createHighlighterCore({
    themes,
    langs,
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
}

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    const pending = createHighlighter();
    highlighterPromise = pending;
    // A chunk that fails to load (say, offline before the service worker has
    // cached it) must not disable highlighting for the whole session: forget the
    // failed attempt so a later code block tries again. A stale deploy is not
    // fixed by a retry; main.tsx's vite:preloadError handler reloads the app.
    pending.catch(() => {
      if (highlighterPromise === pending) highlighterPromise = null;
    });
  }
  return highlighterPromise;
}

function resolveLanguage(lang: string | undefined): string {
  if (!lang) return "text";
  const cleaned = lang.startsWith("language-")
    ? lang.slice("language-".length)
    : lang;
  const lower = cleaned.toLowerCase().trim();
  if (lower === "text" || lower === "plaintext" || lower === "txt")
    return "text";
  return langAlias[lower] ?? lower;
}

/**
 * Custom hook for syntax highlighting with our minimal Shiki bundle
 */
export function useShikiHighlighter(
  code: string,
  language: string | undefined
): ReactNode | null {
  const [highlighted, setHighlighted] = useState<ReactNode | null>(null);
  const lang = useMemo(() => resolveLanguage(language), [language]);

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      let highlighter: HighlighterCore;
      try {
        highlighter = await getHighlighter();
      } catch {
        // The code stays plain text; getHighlighter() retries on the next block.
        if (!cancelled) setHighlighted(null);
        return;
      }
      if (cancelled) return;

      const loadedLangs = highlighter.getLoadedLanguages();

      // Skip highlighting for unsupported languages (graceful fallback to plain text)
      if (lang === "text" || !loadedLangs.includes(lang)) {
        setHighlighted(null);
        return;
      }

      const hast = highlighter.codeToHast(code, {
        lang,
        themes: SHIKI_THEMES,
        defaultColor: false,
        structure: "inline",
      });

      if (cancelled) return;

      const rendered = toJsxRuntime(hast, {
        jsx,
        jsxs,
        Fragment,
      });
      setHighlighted(rendered as ReactNode);
    }

    // Debounce highlighting
    const timer = setTimeout(highlight, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, lang]);

  return highlighted;
}
