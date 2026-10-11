#!/usr/bin/env bun
/**
 * generate-capability-catalog.ts
 *
 * Capability-catalog Tier-0 codegen (issue #3743, epic #2416). Walks the three
 * runtime packages, AST-extracts every LITERAL `defineCapability({...})` call,
 * validates each against the #3741 `catalogEntrySchema`, and emits the committed,
 * byte-stable `shared/src/capabilityCatalog/index.generated.ts` sorted by `id`.
 *
 * WHY a committed index (KD-1): `.github/workflows/test.yml` typechecks a FRESH
 * checkout with NO codegen step before it, so the generated index MUST exist in
 * git (mirrors the `extensions.generated.ts` / `extensionsMetadata.generated.ts`
 * contract). `*.generated.*` is prettier- and eslint-ignored, so the emitted
 * style survives untouched. The live Tier-1 catalog (assembled at boot, cannot
 * drift from the binary) reconciles against THIS index in #3744.
 *
 * LITERAL-ONLY + FAIL-LOUD (KD-3 / R2): a value the AST cannot read at
 * generation time is a value the catalog cannot carry — the extractor accepts
 * only string / boolean / number / nested object / array literals and FAILS with
 * `file:line` on any computed value, spread, variable reference or template
 * substitution. This is the decay vector the epic exists to kill.
 *
 * PARSE, don't copy (R1): the emitted entry is `catalogEntrySchema.parse(literal)`
 * — the PARSE RESULT — so #3741's three `.default()`-bearing fields (`probe`,
 * `telemetry`, `trusted`) are materialized identically on the index side and the
 * live side; otherwise #3744's index<->live reconciliation reports them as
 * permanent drift.
 *
 * SYNTAX-ONLY (3743-11): uses `ts.createSourceFile` (not `ts.createProgram`) —
 * literal extraction needs syntax only, and `check:capabilities-gen-clean` runs
 * inside `bun run lint`, so a full three-package program build on every lint run
 * would be a second whole typecheck. `scripts/*.ts` is neither linted nor
 * typechecked, so this file's own registered test is its only type gate (OR-5).
 *
 * IMPORT NOTE: `scripts/` is NOT a workspace member, so bun cannot runtime-resolve
 * the bare `@hapi/protocol` specifier here (no `node_modules/@hapi` symlink — each
 * of server/cli/web gets its own). The generator therefore imports the schema via
 * a RELATIVE path into `shared/src`, and from the specific submodules (never the
 * barrel) so it never forms a cycle with the emitted `index.generated.ts`.
 *
 * TARGETS TABLE (PART 1B item 12): emission is a `{ name, outFile, render }`
 * table (mirroring `generate-extension-registry.ts`'s `RUNTIMES` + the metadata
 * out-file), and `--check` iterates it — so #3748's `tier0.generated.ts` target
 * and #3750's `agent-self-knowledge.md` targets are drift-guarded automatically
 * the moment they are added, with no ad-hoc emitter escaping the check.
 *
 * WALK ROOTS: `cli/src`, `server/src`, `web/src` — NEVER `shared/src` (R8): the
 * generator's roots deliberately exclude `shared/` so `shared/` stays free of
 * cli/server coupling. The fixture corpus (`scripts/__fixtures__/`) is outside the
 * default roots, so the committed index is driven only by real call sites.
 *
 * See: `docs/internal/architecture/capability-catalog.md`.
 */
import ts from "typescript";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogEntrySchema } from "../shared/src/capabilityCatalog/schema";
import type { CatalogEntry } from "../shared/src/capabilityCatalog/types";
import {
  renderTier0,
  TIER0_NEUTRAL_CONTEXT,
} from "../shared/src/capabilityCatalog/renderTier0";
import {
  renderSelfKnowledge,
  type SelfKnowledgeScope,
} from "../shared/src/capabilityCatalog/renderSelfKnowledge";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/**
 * Default walk roots (R1, R8). NEVER include `shared/src` — keeping cli/server
 * capability declarations out of `shared/` is a deliberate layering rule.
 */
const DEFAULT_WALK_ROOTS = ["cli/src", "server/src", "web/src"] as const;

/** The `defineCapability` identifier name matched at call sites. */
const DEFINE_CALLEE = "defineCapability";

/** A single emission target (PART 1B item 12). `render` sees the full entry set. */
export interface CatalogTarget {
  name: string;
  outFile: string;
  render: (entries: readonly CatalogEntry[]) => string;
}

/** Fail-loud error carrying a `file:line:col` provenance, per R2. */
class CatalogGenError extends Error {}

/** `file:line:col` for a node's start position (1-based line + col). */
function locateNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  const rel = relative(repoRoot, sourceFile.fileName);
  return `${rel}:${line + 1}:${character + 1}`;
}

/**
 * Reconstruct a plain JS value from a LITERAL AST node, or throw a fail-loud
 * `CatalogGenError` (with `file:line:col`) on the first non-literal it meets.
 * Accepts: string / no-substitution-template / numeric (incl. unary minus) /
 * boolean / null / object-literal (literal keys + values) / array-literal.
 * Rejects everything else — identifiers, property access, calls, spreads,
 * shorthand properties, computed keys, template substitutions.
 */
function literalFromNode(node: ts.Node, sourceFile: ts.SourceFile): unknown {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (ts.isParenthesizedExpression(node)) {
    return literalFromNode(node.expression, sourceFile);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const obj: Record<string, unknown> = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) {
        // Spread, shorthand, method, accessor — none are literal fields (R2).
        throw new CatalogGenError(
          `${locateNode(prop, sourceFile)}: non-literal property in ` +
            `defineCapability({...}) — only \`key: <literal>\` entries are allowed ` +
            `(no spreads, shorthand, methods, or computed keys).`
        );
      }
      let key: string;
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) {
        key = prop.name.text;
      } else {
        throw new CatalogGenError(
          `${locateNode(prop.name, sourceFile)}: non-literal property key in ` +
            `defineCapability({...}) — keys must be plain identifiers or string ` +
            `literals (no computed keys).`
        );
      }
      obj[key] = literalFromNode(prop.initializer, sourceFile);
    }
    return obj;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map(el => literalFromNode(el, sourceFile));
  }
  throw new CatalogGenError(
    `${locateNode(node, sourceFile)}: non-literal value in ` +
      `defineCapability({...}) — a computed value, variable reference, call, or ` +
      `template substitution cannot be read at generation time. Inline a literal ` +
      `(a value the catalog cannot statically read is a value it cannot carry).`
  );
}

/** True for a `defineCapability(<identifier callee>)` call expression. */
function isDefineCapabilityCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === DEFINE_CALLEE
  );
}

/** True for a scannable source file (`.ts`/`.tsx`, not test/spec/d.ts/generated). */
function isScannableSourceFile(name: string): boolean {
  if (!/\.tsx?$/.test(name)) return false;
  if (/\.(test|spec)\.tsx?$/.test(name)) return false;
  if (/\.d\.ts$/.test(name)) return false;
  if (/\.generated\./.test(name)) return false;
  return true;
}

/**
 * Resolve one walk root to the set of source files it contributes. A root may be
 * a directory (recursively scanned) OR a single `.ts`/`.tsx` file — the latter
 * lets the registered test point the generator at one flat fixture file (e.g.
 * `non-literal-entry.ts`) without its sibling `valid-entries.ts` also loading.
 */
function resolveRootFiles(rootAbs: string): string[] {
  let st;
  try {
    st = statSync(rootAbs);
  } catch {
    return []; // a missing root is not an error (empty contribution)
  }
  if (st.isFile()) {
    return isScannableSourceFile(rootAbs) ? [rootAbs] : [];
  }
  return listSourceFiles(rootAbs);
}

/** Recursively list `.ts`/`.tsx` source files under `dir` (skips excluded). */
function listSourceFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a missing root is not an error (empty contribution)
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__fixtures__") continue;
      out = out.concat(listSourceFiles(full));
      continue;
    }
    if (isScannableSourceFile(name)) out.push(full);
  }
  return out;
}

/**
 * Walk `roots`, AST-extract every literal `defineCapability({...})`, validate
 * each against `catalogEntrySchema`, and return the PARSED entries sorted by
 * `id` (deterministic; ties broken by canonical serialization). Throws
 * `CatalogGenError` (file:line:col) on a non-literal field or a schema failure.
 *
 * Exported so the registered test can drive the generator over the fixture
 * corpus (Task 10) with a walk-root override.
 */
export function collectEntries(
  roots: readonly string[] = DEFAULT_WALK_ROOTS
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const root of roots) {
    const rootAbs = join(repoRoot, root);
    for (const file of resolveRootFiles(rootAbs)) {
      const text = readFileSync(file, "utf8");
      // Cheap pre-filter: only a file whose text mentions the callee can contain
      // a call site, so skip the (expensive) AST parse for the ~99% that don't.
      // This keeps `check:capabilities-gen-clean` cheap inside `bun run lint`.
      if (!text.includes(DEFINE_CALLEE)) continue;
      const sourceFile = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
      );
      const visit = (node: ts.Node): void => {
        if (isDefineCapabilityCall(node)) {
          if (node.arguments.length !== 1) {
            throw new CatalogGenError(
              `${locateNode(node, sourceFile)}: defineCapability(...) must take ` +
                `exactly one object-literal argument (found ${node.arguments.length}).`
            );
          }
          const arg = node.arguments[0];
          if (!ts.isObjectLiteralExpression(arg)) {
            throw new CatalogGenError(
              `${locateNode(arg, sourceFile)}: defineCapability(...) argument must ` +
                `be an inline object literal (found a ${ts.SyntaxKind[arg.kind]}).`
            );
          }
          const literal = literalFromNode(arg, sourceFile);
          const result = catalogEntrySchema.safeParse(literal);
          if (!result.success) {
            const issues = result.error.issues
              .map(i => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
              .join("\n");
            throw new CatalogGenError(
              `${locateNode(arg, sourceFile)}: defineCapability({...}) failed ` +
                `catalogEntrySchema validation:\n${issues}`
            );
          }
          entries.push(result.data);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  entries.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    // Deterministic tie-break so equal ids never reorder run-to-run.
    return canonicalJson(a) < canonicalJson(b) ? -1 : 1;
  });
  return entries;
}

/**
 * Canonical JSON with recursively SORTED object keys — so the emitted bytes are
 * identical regardless of the order fields were declared in at the call site
 * (the determinism contract, R10 / V1). `indent` gives a pretty multi-line form;
 * omit it for the compact tie-break key.
 */
function canonicalJson(value: unknown, indent?: number, depth = 1): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  const nl = indent ? "\n" : "";
  const pad = indent ? " ".repeat(indent * depth) : "";
  const padEnd = indent ? " ".repeat(indent * (depth - 1)) : "";
  const sep = indent ? "," + nl : ",";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map(v => pad + canonicalJson(v, indent, depth + 1));
    return "[" + nl + items.join(sep) + nl + padEnd + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length === 0) return "{}";
  const items = keys.map(
    k =>
      pad +
      JSON.stringify(k) +
      ": " +
      canonicalJson((value as Record<string, unknown>)[k], indent, depth + 1)
  );
  return "{" + nl + items.join(sep) + nl + padEnd + "}";
}

const GENERATED_HEADER = [
  "// DO NOT EDIT — generated by scripts/generate-capability-catalog.ts",
  "// Regenerate via `bun run gen:capabilities`. This file is COMMITTED to git",
  "// (CI typechecks a fresh checkout with no codegen step before it). Source of",
  "// truth: literal defineCapability({...}) call sites across cli/src, server/src,",
  "// and web/src (issue #3743). Sub-Issues E (#3745) / F (#3746) populate it.",
].join("\n");

/** Render the Tier-0 committed index (the sole target at C-time). */
export function renderIndex(entries: readonly CatalogEntry[]): string {
  const body =
    entries.length === 0
      ? "export const capabilityCatalogIndex: readonly CatalogEntry[] = [];\n"
      : "export const capabilityCatalogIndex: readonly CatalogEntry[] = " +
        canonicalJson(entries as unknown[], 2) +
        ";\n";
  return (
    GENERATED_HEADER +
    "\n" +
    'import type { CatalogEntry } from "./types";\n' +
    "\n" +
    body
  );
}

/**
 * Render the committed Tier-0 snapshot module (issue #3748, Task 2). The rendered
 * text is emitted as a string constant using the EXPLICIT neutral context
 * (`TIER0_NEUTRAL_CONTEXT` — no launcher/agent/session), so this file is the
 * budget/determinism snapshot; `buildSystemPrompt` calls `renderTier0` live so
 * #3749 can vary it per session.
 */
export function renderTier0Module(entries: readonly CatalogEntry[]): string {
  const text = renderTier0(entries, TIER0_NEUTRAL_CONTEXT);
  return (
    GENERATED_HEADER +
    "\n" +
    "export const tier0CapabilityBlock = " +
    JSON.stringify(text) +
    ";\n"
  );
}

/** The BASE emission targets (issue #3743, #3748). `--check` and the default run
 * iterate these PLUS the scope-parameterized self-knowledge targets (#3750). */
export const TARGETS: CatalogTarget[] = [
  {
    name: "index",
    outFile: "shared/src/capabilityCatalog/index.generated.ts",
    render: renderIndex,
  },
  {
    name: "tier0",
    outFile: "shared/src/capabilityCatalog/tier0.generated.ts",
    render: renderTier0Module,
  },
];

/**
 * The hand-authored preamble the self-knowledge renderings include verbatim
 * (issue #3750, Task 2). `renderSelfKnowledge` is PURE (browser-safe `shared/`,
 * no `node:fs`), so the GENERATOR reads the file here and passes its TEXT in —
 * mirroring #3748's `renderTier0` (the generator does the I/O).
 */
const SELF_KNOWLEDGE_PREAMBLE_PATH =
  "infrastructure/cloud-vm/selfKnowledge.preamble.md";

/** Read the self-knowledge preamble file (throws loud if it is missing). */
function readSelfKnowledgePreamble(): string {
  return readFileSync(join(repoRoot, SELF_KNOWLEDGE_PREAMBLE_PATH), "utf8");
}

/**
 * The `agent-self-knowledge.md` emission targets (issue #3750, Task 3). Two
 * scopes from ONE catalog (KD-1): the `user` doc OVERWRITES the hand-authored
 * #2521 file, the `operator` doc is greenfield (`infrastructure/operator/`).
 * `render` closes over the preamble TEXT so `CatalogTarget.render`'s
 * `(entries) => string` shape is preserved and `--check` drift-guards both the
 * same way it guards the index/tier0 targets. Each render THROWS past its byte
 * ceiling (R3) or on a no-scope entry (D4) — `main` turns that into a clean
 * non-zero exit.
 */
function buildSelfKnowledgeTargets(preambleText: string): CatalogTarget[] {
  const specs: { name: string; outFile: string; scope: SelfKnowledgeScope }[] =
    [
      {
        name: "self-knowledge-user",
        outFile: "infrastructure/cloud-vm/agent-self-knowledge.md",
        scope: "user",
      },
      {
        name: "self-knowledge-operator",
        outFile: "infrastructure/operator/agent-self-knowledge.md",
        scope: "operator",
      },
    ];
  return specs.map(({ name, outFile, scope }) => ({
    name,
    outFile,
    render: entries => renderSelfKnowledge(entries, scope, preambleText),
  }));
}

/**
 * The embedded self-knowledge preamble target (issue #3873, Task 1). The pure
 * `renderSelfKnowledge` takes the preamble TEXT as a parameter; today ONLY the
 * generator can supply it (it reads `selfKnowledge.preamble.md` via fs), and that
 * `.md` does NOT ship to the VM — so a RUNTIME importer (the boot self-heal writer
 * `server/src/capabilities/selfKnowledgeBootWriter.ts`, #3873) has no way to read
 * it. Embed the preamble into the binary as a committed generated const (mirroring
 * `tier0.generated.ts`), so the boot writer can `import { SELF_KNOWLEDGE_PREAMBLE }`.
 * `render` ignores `entries` (the const is preamble-only) and `--check`
 * drift-guards it exactly like the index / tier0 / self-knowledge-* targets.
 */
function buildPreambleTarget(preambleText: string): CatalogTarget {
  return {
    name: "self-knowledge-preamble",
    outFile: "shared/src/capabilityCatalog/selfKnowledge.preamble.generated.ts",
    render: () =>
      GENERATED_HEADER +
      "\n" +
      "export const SELF_KNOWLEDGE_PREAMBLE = " +
      JSON.stringify(preambleText) +
      ";\n",
  };
}

/**
 * CLI. Default: write every target. `--check`: render every target in memory and
 * compare against the committed file, exit 1 on any drift, WITHOUT touching the
 * tree (`git status --porcelain` unchanged). `--roots a,b`: override walk roots
 * (used only by the registered test's fixture-corpus runs).
 */
export function main(argv: readonly string[]): number {
  const check = argv.includes("--check");
  const rootsArg = argv.find(a => a.startsWith("--roots="));
  const roots = rootsArg
    ? rootsArg
        .slice("--roots=".length)
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    : DEFAULT_WALK_ROOTS;

  let entries: CatalogEntry[];
  try {
    entries = collectEntries(roots);
  } catch (e) {
    if (e instanceof CatalogGenError) {
      console.error(`[gen:capabilities] ${e.message}`);
      return 1;
    }
    throw e;
  }

  // Compose the base targets (index, tier0) with the scope-parameterized
  // self-knowledge targets (#3750). Reading the preamble is I/O the pure renderer
  // must not do — a missing file fails the build loud, not silently.
  let allTargets: CatalogTarget[];
  try {
    // Read the preamble ONCE and share it: the boot-embed const (#3873) and the
    // two rendered `.md` docs must derive from the SAME preamble text.
    const preambleText = readSelfKnowledgePreamble();
    allTargets = [
      ...TARGETS,
      buildPreambleTarget(preambleText),
      ...buildSelfKnowledgeTargets(preambleText),
    ];
  } catch (e) {
    console.error(
      `[gen:capabilities] cannot read ${SELF_KNOWLEDGE_PREAMBLE_PATH}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return 1;
  }

  let drift = false;
  for (const target of allTargets) {
    const outPath = join(repoRoot, target.outFile);
    let rendered: string;
    try {
      rendered = target.render(entries);
    } catch (e) {
      // A render throw is a build failure by design (#3750 R3 byte budget / D4
      // no-scope). Report cleanly and exit non-zero rather than crash-tracing.
      console.error(
        `[gen:capabilities] ${target.name}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return 1;
    }
    if (check) {
      let current: string | null = null;
      try {
        current = readFileSync(outPath, "utf8");
      } catch {
        current = null;
      }
      if (current !== rendered) {
        drift = true;
        console.error(
          `[gen:capabilities] --check: ${target.outFile} is STALE — run ` +
            `\`bun run gen:capabilities\` and commit the result.`
        );
      }
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, rendered);
      console.log(
        `[gen:capabilities] Wrote ${entries.length} entr${
          entries.length === 1 ? "y" : "ies"
        } to ${target.outFile}`
      );
    }
  }

  if (check && drift) return 1;
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
