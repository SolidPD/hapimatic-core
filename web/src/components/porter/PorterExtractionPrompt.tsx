// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Copy, Check, ChevronDown, Download, Terminal, X } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { usePorterRecipient } from "@/hooks/queries/usePorterRecipient";
import { usePorterToken } from "@/hooks/mutations/usePorterToken";
import {
  PORTER_TRUST_COPY,
  PORTER_REGULAR_TERMINAL_COPY,
  PORTER_CLAUDE_CODE_PATH_COPY,
} from "@/components/porter/porterCopy";
import { detectOsTab, type OsTab } from "@/components/porter/osTab";
import type { ImportPlanSummary } from "@/types/porter";
import { Button } from "@/components/ui/button";

/**
 * PorterExtractionPrompt — the "export this machine's configuration" panel of the
 * Admin → Configuration page's Import tab (issue #2344; reworked by #3245).
 *
 * #3245 makes the DEFAULT export a script-driven, secrets-free flow: the panel
 * presents a downloadable/copyable shell SCRIPT (`data.script`, built by
 * `buildExportScript`) the user runs directly on the source machine — NO Claude
 * session, NO secrets. It replaces the old default of pasting an LLM prompt that
 * asked the model to bundle + encrypt credentials, which newer Claude models
 * hard-refuse.
 *
 * The LLM-prompt path (`data.prompt`) is PRESERVED but DEMOTED to an advanced,
 * opt-in "include secrets (LLM-assisted)" disclosure (collapsed by default). Both
 * `script` and `prompt` are built SERVER-SIDE and displayed VERBATIM — never
 * rebuilt client-side (a second construction path for a security-relevant
 * instruction would drift).
 */

/** Trigger a browser download of text content as a file (precedent: csvExport.ts). */
function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Format a remaining-ms duration as `m:ss` for the token TTL countdown (#3446). */
function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * PorterInstructionsCard — #3449 (Sub D): the dismissable, reopenable guidance
 * card beside the one-liner. It reads the SINGLE K8 OS source via the `os` prop
 * (never `navigator.userAgent`; the parent owns the one detector) and shows:
 *   - the P7(a) regular-terminal / source-machine sentence (R3, rendered once),
 *   - OS-aware terminal-opening wording (R2) — Linux Ctrl+Alt+T + WSL line,
 *     macOS Spotlight → Terminal, Windows PowerShell (never WSL),
 *   - the conditional jq install hint on Linux/macOS only (R2/K14 — macOS 15+
 *     ships /usr/bin/jq, so it is NOT unconditional),
 *   - the paste-into-Claude-Code path (R4), distinct from the legacy Advanced
 *     LLM prompt,
 *   - the SECOND `porter-trust-copy` slot (R5/K9); A's received banner is the
 *     first, both from the one `PORTER_TRUST_COPY` constant.
 */
function PorterInstructionsCard({
  os,
  onDismiss,
}: {
  os: OsTab;
  onDismiss: () => void;
}) {
  // jq install hint on Linux/macOS only — Windows uses the PowerShell irm | iex
  // path, and macOS 15+ ships jq, so the line is conditional [K14][1B#44].
  const showJqLine = os === "linux" || os === "macos";
  return (
    <div
      data-testid="instructions-card"
      className="flex flex-col gap-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[length:var(--text-body)] font-semibold text-[var(--app-fg)]">
          <Terminal className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
          How to run this
        </span>
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          onClick={onDismiss}
          data-testid="instructions-dismiss"
          aria-label="Dismiss instructions"
          className="shrink-0 font-normal text-[var(--app-hint)] hover:text-[var(--app-fg)]"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* R3 / P7(a): run on the SOURCE machine, in a regular terminal. */}
      <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
        {PORTER_REGULAR_TERMINAL_COPY}
      </p>

      {/* R2: OS-aware terminal-opening wording, driven by the K8 osTab (`os` prop). */}
      {os === "linux" && (
        <div className="flex flex-col gap-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          <p>
            Open a terminal with{" "}
            <kbd className="rounded border border-[var(--app-border)] px-1 font-mono">
              Ctrl+Alt+T
            </kbd>
            , then paste the command above and press Enter.
          </p>
          <p data-testid="instructions-wsl-line">
            Using WSL? Open your WSL distro from the Start menu, then run the
            Linux command.
          </p>
        </div>
      )}
      {os === "macos" && (
        <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          Open Terminal — press{" "}
          <kbd className="rounded border border-[var(--app-border)] px-1 font-mono">
            &#8984; Space
          </kbd>
          , type &ldquo;Terminal&rdquo;, press Enter — then paste the command
          above.
        </p>
      )}
      {os === "windows" && (
        <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          Open PowerShell — press the Start key, type &ldquo;PowerShell&rdquo;,
          press Enter — then paste the command above.
        </p>
      )}

      {/* R2 / K14: conditional jq install hint — Linux/macOS only. */}
      {showJqLine && (
        <p
          data-testid="instructions-jq-line"
          className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        >
          macOS 14 or earlier (or Linux without jq): install jq first —{" "}
          <code className="font-mono text-[var(--app-fg)]">
            brew install jq
          </code>{" "}
          /{" "}
          <code className="font-mono text-[var(--app-fg)]">
            sudo apt install jq
          </code>
          .
        </p>
      )}

      {/* R4: paste-into-Claude-Code path — distinct from the legacy Advanced prompt. */}
      <p
        data-testid="instructions-claude-code-path"
        className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
      >
        {PORTER_CLAUDE_CODE_PATH_COPY}
      </p>

      {/* R5 / K9: the second PORTER_TRUST_COPY slot (A's received banner is the first). */}
      <p
        data-testid="porter-trust-copy"
        className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
      >
        {PORTER_TRUST_COPY}
      </p>
    </div>
  );
}

export function PorterExtractionPrompt({
  onReceived,
  os,
}: {
  /**
   * #3446 (Sub A, 1B#4): called with the staged plan when the one-liner's token
   * transitions to `received`, so the parent lifts it into the sibling import
   * panel's review UI. The panel and this prompt share no cache key, so the plan
   * is lifted through the common parent (`InstalledConfigTabs`).
   */
  onReceived?: (summary: ImportPlanSummary) => void;
  /**
   * #3447 (Sub B, K8): optional OS-tab override. Defaults to
   * `detectOsTab(navigator.userAgent)`; tests pass it rather than redefining
   * `navigator.userAgent`. This is the SINGLE OS source — D (#3449) consumes
   * the same selected value.
   */
  os?: OsTab;
} = {}) {
  const { api } = useAppContext();
  const { data, isLoading, isError } = usePorterRecipient(api);
  const { mint, status } = usePorterToken(api);
  const [copiedScript, setCopiedScript] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedOneliner, setCopiedOneliner] = useState(false);
  // The whole section is collapsible from its own heading (#2745 pattern).
  const [open, setOpen] = useState(true);
  // The LLM-assisted secrets path is opt-in, collapsed by default (#3245).
  const [showAdvanced, setShowAdvanced] = useState(false);
  // #3449 (Sub D): the guidance card is shown by default, dismissable in-session
  // via its own X and toggleable via the always-visible "Instructions" control
  // beside Copy. In-session only (cross-reload persistence deliberately deferred).
  const [instructionsDismissed, setInstructionsDismissed] = useState(false);
  // Ticks the TTL countdown once per second while a token is live + unresolved.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const tokenState = status.data?.state;
  // #3447 (K8): per-OS command tabs. The selected OS defaults to the UA-detected
  // tab and is overridable via the `os` prop; this state is the SINGLE OS source
  // (D #3449 consumes the same selected value).
  const [osTab, setOsTab] = useState<OsTab>(
    () => os ?? detectOsTab(navigator.userAgent)
  );
  const psUrl = mint.data
    ? (mint.data.fetchUrlPowerShell ?? `${mint.data.fetchUrl}.ps1`)
    : "";
  const osCommands: Record<OsTab, string> = mint.data
    ? {
        linux: `curl -fsSL ${mint.data.fetchUrl} | bash`,
        macos: `curl -fsSL ${mint.data.fetchUrl} | bash`,
        windows: `irm ${psUrl} | iex`,
      }
    : { linux: "", macos: "", windows: "" };
  const oneliner = osCommands[osTab];
  const countdownActive = Boolean(mint.data) && tokenState !== "expired";
  const remainingMs = mint.data ? mint.data.expiresAt - nowMs : 0;

  // TTL countdown tick — only while a token is live and unresolved (no idle timer).
  useEffect(() => {
    if (!countdownActive) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [countdownActive]);

  // SSE wake-up: refetch the status the instant the source machine uploads. The
  // event rides the single useSSE stream (re-emitted as hapi:porterTokenReceived);
  // polling is the fallback. `refetch` identity is stable per query.
  const { refetch } = status;
  const token = mint.data?.token;
  useEffect(() => {
    if (!token) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { token?: string }
        | undefined;
      if (detail?.token === token) void refetch();
    };
    window.addEventListener("hapi:porterTokenReceived", handler);
    return () =>
      window.removeEventListener("hapi:porterTokenReceived", handler);
  }, [token, refetch]);

  // Lift the staged plan to the parent so the import panel hydrates its review.
  const receivedPlan =
    tokenState === "received" ? status.data?.plan : undefined;
  useEffect(() => {
    if (receivedPlan) onReceived?.(receivedPlan);
  }, [receivedPlan, onReceived]);

  const copy = async (
    text: string | undefined,
    setCopied: (v: boolean) => void
  ) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied (insecure context / permissions) — leave the text
      // visible so the user can select-and-copy manually.
    }
  };

  const handleDownloadScript = () => {
    // #3381: consume the server-supplied, versioned `scriptFilename` verbatim —
    // never construct a filename client-side. When it is absent (a dev-only
    // vite-against-an-older-server session, since the web bundle ships with the
    // same server build) the download is a no-op rather than saving under an
    // unversioned name that would silently overwrite a prior copy.
    if (!data?.script || !data.scriptFilename) return;
    downloadText(data.script, data.scriptFilename, "text/x-shellscript");
  };

  return (
    <section data-testid="config-export" className="flex flex-col gap-3">
      <div>
        <Button
          type="button"
          variant="ghostStatic"
          size="bare"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          data-testid="config-export-toggle"
          className="flex w-full items-center justify-start gap-1.5 text-left font-normal hover:text-[var(--app-fg)]"
        >
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
          <h2 className="text-sm font-semibold text-[var(--app-fg)]">
            Export configuration
          </h2>
        </Button>
        {open && (
          <p className="mt-0.5 text-[length:var(--text-body)] text-[var(--app-hint)]">
            Generate a one-time link, then paste the command below into a
            terminal on the machine whose configuration you want to bring over.
            It packages your config <strong>definitions</strong> — skills,
            agents, commands, hooks, and MCP server definitions — with{" "}
            <strong>no secrets</strong> and no Claude/LLM step, and uploads them
            back here for you to review before anything is written.
          </p>
        )}
      </div>

      {open && (
        <div
          data-testid="oneliner-card"
          className="flex flex-col gap-3 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3"
        >
          {!mint.data ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => mint.mutate()}
                disabled={mint.isPending}
                data-testid="generate-oneliner"
                className="flex h-auto items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-accent px-3 py-1.5 text-[length:var(--text-body)] font-medium text-[var(--app-bg)] transition-opacity hover:bg-accent hover:text-[var(--app-bg)] hover:opacity-90"
              >
                {mint.isPending ? "Generating…" : "Generate link"}
              </Button>
              <span className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                Creates a one-time link that expires after ~15 minutes.
              </span>
            </div>
          ) : (
            <>
              {/* #3447 (K8): per-OS command tabs. Selecting a tab swaps the
                  command below; the Windows tab shows the PowerShell irm | iex
                  one-liner. This selection is the single OS source D consumes. */}
              <div
                role="tablist"
                aria-label="Operating system"
                className="flex items-center gap-1 border-b border-[var(--app-border)]"
              >
                {(
                  [
                    { id: "linux", label: "Linux" },
                    { id: "macos", label: "macOS" },
                    { id: "windows", label: "Windows" },
                  ] as { id: OsTab; label: string }[]
                ).map(t => (
                  <Button
                    key={t.id}
                    type="button"
                    variant="ghostStatic"
                    role="tab"
                    aria-selected={osTab === t.id}
                    onClick={() => setOsTab(t.id)}
                    data-testid={`os-tab-${t.id}`}
                    className={`-mb-px h-auto rounded-none border-b-2 px-3 py-1.5 text-[length:var(--text-body-dense)] font-medium transition-colors hover:text-[var(--app-fg)] ${
                      osTab === t.id
                        ? "border-accent text-[var(--app-fg)]"
                        : "border-transparent text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                    }`}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
              <div className="flex items-start gap-2" role="tabpanel">
                <code
                  data-testid="oneliner-command"
                  className="flex-1 break-all rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-[length:var(--text-body-dense)] text-[var(--app-fg)]"
                >
                  {oneliner}
                </code>
                <div className="flex shrink-0 flex-col items-stretch gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => copy(oneliner, setCopiedOneliner)}
                    data-testid="copy-oneliner"
                    className="flex h-auto items-center justify-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-2 text-[length:var(--text-body-dense)] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                  >
                    {copiedOneliner ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-ok" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </>
                    )}
                  </Button>
                  {/* #3449 (Sub D): always-visible control to reopen/toggle the
                      guidance card (#3443 R5 persistent-button semantics). */}
                  <Button
                    type="button"
                    variant="ghostStatic"
                    size="bare"
                    onClick={() => setInstructionsDismissed(d => !d)}
                    data-testid="instructions-reopen"
                    aria-expanded={!instructionsDismissed}
                    className="flex h-auto items-center justify-center gap-1.5 px-2.5 py-1 text-[length:var(--text-body-dense)] font-normal text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                  >
                    <Terminal className="h-3.5 w-3.5" />
                    Instructions
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                {tokenState !== "expired" && (
                  <span data-testid="oneliner-countdown">
                    Expires in {formatRemaining(remainingMs)}
                  </span>
                )}
                <Button
                  type="button"
                  variant="ghostStatic"
                  size="bare"
                  onClick={() => mint.mutate()}
                  disabled={mint.isPending}
                  data-testid="new-oneliner-link"
                  className="font-normal text-accent hover:opacity-90"
                >
                  New link
                </Button>
              </div>

              {/* #3449 (Sub D): dismissable/reopenable guidance card. Reads the
                  single K8 osTab; stays visible through waiting/received (so the
                  received banner + this card render both K9 trust-copy slots). */}
              {!instructionsDismissed && (
                <PorterInstructionsCard
                  os={osTab}
                  onDismiss={() => setInstructionsDismissed(true)}
                />
              )}

              {tokenState === "waiting" && (
                <div
                  data-testid="oneliner-waiting"
                  className="flex items-center gap-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                >
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                  Waiting for the source machine to run the command…
                  {typeof status.data?.fetchCount === "number" &&
                    status.data.fetchCount > 0 &&
                    ` (script fetched ${status.data.fetchCount}×)`}
                </div>
              )}

              {tokenState === "expired" && (
                <p
                  data-testid="oneliner-expired"
                  className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                >
                  This link expired before it was used. Generate a new link to
                  try again.
                </p>
              )}

              {tokenState === "received" && (
                <div
                  data-testid="porter-received"
                  className="flex flex-col gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3"
                >
                  <span className="flex items-center gap-1.5 text-[length:var(--text-body)] font-semibold text-ok">
                    <Check className="h-4 w-4" />
                    Configuration received
                  </span>
                  <p
                    data-testid="porter-trust-copy"
                    className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
                  >
                    {PORTER_TRUST_COPY}
                  </p>
                  {/* #5202 (U14): the archive arrived but its review could not
                      be built (the detail is in the server log). */}
                  {status.data?.planError ? (
                    <p
                      data-testid="porter-plan-error"
                      className="text-[length:var(--text-body-dense)] text-hot"
                    >
                      The review of this configuration could not be built.
                      Generate a new link and run the command again.
                    </p>
                  ) : (
                    <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                      Review the plan below and commit when you&apos;re ready.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {mint.isError && (
            <p
              data-testid="oneliner-error"
              className="text-[length:var(--text-body-dense)] text-hot"
            >
              Failed to generate a link. Try again.
            </p>
          )}
        </div>
      )}

      {open && isLoading && (
        <p className="py-2 text-sm text-[var(--app-hint)]">
          Loading export script…
        </p>
      )}
      {open && isError && !isLoading && (
        <p className="py-2 text-sm text-hot" data-testid="script-error">
          Failed to load the export script.
        </p>
      )}

      {open && data && (
        <>
          <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
            Prefer to inspect it first? Download or copy the same script, run it
            yourself on the source machine, and upload the archive it prints in
            the panel below.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={handleDownloadScript}
              data-testid="download-script"
              className="flex h-auto items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-accent px-3 py-1.5 text-[length:var(--text-body)] font-medium text-[var(--app-bg)] transition-opacity hover:bg-accent hover:text-[var(--app-bg)] hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Download export script
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => copy(data.script, setCopiedScript)}
              data-testid="copy-script"
              className="flex h-auto items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-1.5 text-[length:var(--text-body)] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
            >
              {copiedScript ? (
                <>
                  <Check className="h-3.5 w-3.5 text-ok" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy script
                </>
              )}
            </Button>
          </div>

          {/* #3449 (Sub D): cross-machine fallback — reads the server-supplied
              scriptFilename directly (no ??, no shared local); guarded so it
              never renders `~/Downloads/undefined` on the dev-vite-vs-old-server
              path that also no-ops the Download button [C6][C8]. */}
          {data.scriptFilename && (
            <p
              data-testid="script-fallback-line"
              className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
            >
              Not on this machine? Click{" "}
              <strong className="text-[var(--app-fg)]">Copy script</strong>,
              save it on the source machine, then run{" "}
              <code className="font-mono text-[var(--app-fg)]">
                bash ~/Downloads/{data.scriptFilename}
              </code>
              .
            </p>
          )}

          <textarea
            autoCapitalize="none"
            readOnly
            value={data.script}
            data-testid="script-text"
            aria-label="Configuration export script"
            className="h-64 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 font-mono text-[length:var(--text-body-dense)] leading-relaxed text-[var(--app-fg)]"
          />

          <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3">
            <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-fg)]">
              What this export includes
            </h3>
            <ul className="mt-2 flex flex-col gap-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
              <li>
                <span className="font-semibold text-[var(--app-fg)]">
                  Definitions only — no secrets.
                </span>{" "}
                The archive carries your config structure (skills, agents,
                commands, rules, hooks, and MCP server definitions) but never a
                credential, API key, or token.
              </li>
              <li>
                <span className="font-semibold text-[var(--app-fg)]">
                  Re-authenticate on the destination.
                </span>{" "}
                MCP servers and environment values that need credentials are
                flagged for re-authentication after import — you supply those
                values on the destination instance, not in the archive.
              </li>
              <li>
                <span className="font-semibold text-[var(--app-fg)]">
                  No Claude/LLM step.
                </span>{" "}
                The script is deterministic shell that you run directly, so no
                model is asked to package your configuration.
              </li>
            </ul>
          </div>

          {/* Advanced, opt-in: the legacy LLM-assisted secrets export (#3245). */}
          <div>
            <Button
              type="button"
              variant="ghostStatic"
              size="bare"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced(s => !s)}
              data-testid="extraction-prompt-toggle"
              className="flex w-full items-center justify-start gap-1.5 text-left font-normal hover:text-[var(--app-fg)]"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform ${
                  showAdvanced ? "" : "-rotate-90"
                }`}
              />
              <span className="text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
                Advanced: include secrets (LLM-assisted)
              </span>
            </Button>

            {showAdvanced && (
              <div className="mt-2 flex flex-col gap-3">
                <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                  This path pastes a prompt into a Claude session on the source
                  machine that ALSO encrypts your secrets to this instance.
                  Newer Claude models may refuse it — prefer the script above.
                  Credential porting is under review (see the porter
                  architecture docs).
                </p>
                <div className="relative">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => copy(data.prompt, setCopiedPrompt)}
                    data-testid="copy-prompt"
                    className="absolute right-2 top-2 flex h-auto items-center gap-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-[length:var(--text-body-dense)] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                  >
                    {copiedPrompt ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-ok" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </>
                    )}
                  </Button>
                  <textarea
                    autoCapitalize="none"
                    readOnly
                    value={data.prompt}
                    data-testid="prompt-text"
                    aria-label="Extraction prompt (LLM-assisted, includes secrets)"
                    className="h-64 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 pr-20 font-mono text-[length:var(--text-body-dense)] leading-relaxed text-[var(--app-fg)]"
                  />
                </div>

                <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3">
                  <h3 className="text-[length:var(--text-caption)] font-semibold uppercase tracking-wide text-[var(--app-fg)]">
                    What this encryption does and does not protect
                  </h3>
                  <ul className="mt-2 flex flex-col gap-2 text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
                    <li>
                      <span className="font-semibold text-[var(--app-fg)]">
                        Protects in transit and at rest.
                      </span>{" "}
                      The archive is encrypted to the destination instance the
                      moment it leaves the source machine, and stays encrypted
                      until the destination decrypts it to use the secrets.
                    </li>
                    <li>
                      <span className="font-semibold text-[var(--app-fg)]">
                        Does NOT protect against the destination instance.
                      </span>{" "}
                      The destination holds the private key and must decrypt the
                      secrets to use them — it is a trusted party by
                      construction, not a party this encryption defends against.
                    </li>
                    <li>
                      <span className="font-semibold text-[var(--app-fg)]">
                        Does NOT protect the source machine.
                      </span>{" "}
                      The source already holds its own MCP credentials in
                      plaintext (that is where they are being copied from); this
                      feature does not change that.
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
