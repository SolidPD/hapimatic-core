// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";
import axios, { type AxiosError, type AxiosResponse } from "axios";
import { configuration } from "@/configuration";
import { describeErrorKind } from "@/persistence";

const REDACTED = "[redacted]";

/**
 * True when `serverUrl` is an http(s) URL whose host is this machine:
 * `localhost`, `[::1]`, or an address in 127.0.0.0/8 (issue #5136). The token
 * in settings.json belongs to this machine's instance, so it is sent only to a
 * loopback server.
 *
 * WHATWG URL parsing normalises the spellings first (`LOCALHOST`, `127.1`,
 * `0x7f.0.0.1`, `[0:0:0:0:0:0:0:1]`). Everything else is false, including
 * `0.0.0.0`, `localhost.`, IPv4-mapped IPv6 and every DNS name: a false
 * "remote" costs one CLI_API_TOKEN export, a false "loopback" sends the token
 * off the machine.
 */
export function isLoopbackServerUrl(serverUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Where {@link resolveCliApiToken} found a token, or why it found none. */
export type CliTokenResolution =
  | { kind: "env"; token: string }
  | { kind: "settings"; token: string; webappPort?: number }
  | { kind: "missing" }
  | { kind: "remote-url" }
  | { kind: "unreadable"; errorKind: string };

type UnusableResolution = Extract<
  CliTokenResolution,
  { kind: "missing" | "remote-url" | "unreadable" }
>;

/**
 * Resolve CLI_API_TOKEN for the non-interactive API commands (`hapi api`,
 * `hapi capabilities`, `hapi federation`) — issues #5080, #5136, #4498 Task 1.
 *
 * Order:
 * 1. The CLI_API_TOKEN environment variable, for any server (`env`).
 * 2. When the server URL is not a loopback address ({@link
 *    isLoopbackServerUrl}): `remote-url`, without reading settings.json, so
 *    this machine's token never leaves it ({@link authenticateCli} also sends
 *    a settings token with no proxy and no redirects).
 * 3. `cliApiToken` in `<HAPI_HOME>/settings.json` (where `hapi auth login` and
 *    the server's first run save it): `settings`. A missing file or token is
 *    `missing`; a file that cannot be read, is not valid JSON or is not a JSON
 *    object is `unreadable`, carrying the error's code or class only, because
 *    a JSON.parse message can quote the file (#4155 R10).
 *
 * The env check reads `process.env`, not `configuration.cliApiToken`: a
 * settings token is promoted into the singleton, so a second call in the same
 * process would otherwise report it as an env token.
 *
 * This deliberately does NOT call `initializeToken()` (`@/ui/tokenInit`): that
 * prompts on a TTY, writes the prompt to stdout, and saves the token to
 * settings.json. These commands are non-interactive and scripts often parse
 * their stdout, so they must never prompt; they only read credentials, so they
 * must never write settings.json.
 */
export async function resolveCliApiToken(): Promise<CliTokenResolution> {
  const envToken = process.env.CLI_API_TOKEN;
  if (envToken) {
    return { kind: "env", token: envToken };
  }

  if (!isLoopbackServerUrl(configuration.serverUrl)) {
    return { kind: "remote-url" };
  }

  let content: string;
  try {
    content = await readFile(configuration.settingsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", errorKind: describeErrorKind(error) };
  }

  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch (error) {
    return { kind: "unreadable", errorKind: describeErrorKind(error) };
  }
  if (
    settings === null ||
    typeof settings !== "object" ||
    Array.isArray(settings)
  ) {
    return { kind: "unreadable", errorKind: "not a JSON object" };
  }

  const { cliApiToken, webappPort } = settings as {
    cliApiToken?: unknown;
    webappPort?: unknown;
  };
  if (typeof cliApiToken !== "string" || cliApiToken === "") {
    return { kind: "missing" };
  }
  configuration._setCliApiToken(cliApiToken);
  return typeof webappPort === "number" &&
    Number.isInteger(webappPort) &&
    webappPort >= 1 &&
    webappPort <= 65535
    ? { kind: "settings", token: cliApiToken, webappPort }
    : { kind: "settings", token: cliApiToken };
}

/** The error printed when neither token source is set. Names both sources. */
export function missingCliApiTokenMessage(): string {
  return `CLI_API_TOKEN is required: set the CLI_API_TOKEN environment variable, or cliApiToken in ${configuration.settingsFile} (\`hapi auth login\` saves it there).`;
}

/**
 * The error printed when CLI_API_TOKEN is unset and the server URL is not a
 * loopback address (#5136): the settings.json token is not sent there.
 */
export function remoteServerUrlMessage(): string {
  return `CLI_API_TOKEN is required for ${configuration.serverUrl}: it is not a loopback address (localhost, 127.0.0.0/8 or [::1]), so the token in ${configuration.settingsFile} is not sent there. Set the CLI_API_TOKEN environment variable to that server's token.`;
}

/**
 * The error printed when settings.json exists but cannot be used (#5136).
 * `errorKind` is an error code or class, never a message (#4155 R10).
 */
export function unreadableSettingsMessage(errorKind: string): string {
  return `Cannot read ${configuration.settingsFile}: ${errorKind}. Fix or remove that file, or set the CLI_API_TOKEN environment variable.`;
}

/**
 * The line printed when a login with a settings.json token gets no HTTP
 * response (#5136): the URL, where it came from, the error kind and the file.
 * When the file records a different `webappPort` (the server writes it), it
 * names that port too; the file's value can be stale, so it is only a hint.
 */
export function unreachableServerMessage(
  errorKind: string,
  webappPort?: number
): string {
  const url = configuration.serverUrl;
  const source = process.env.HAPI_SERVER_URL
    ? "comes from HAPI_SERVER_URL"
    : "is the built-in default (HAPI_SERVER_URL is unset)";
  const message = `Could not reach ${url}/api/auth (${errorKind}). The URL ${source}; the token was read from ${configuration.settingsFile}.`;
  if (webappPort === undefined || webappPort === effectivePort(url)) {
    return message;
  }
  return `${message} That file records webappPort ${webappPort}; if that is this machine's server, set HAPI_SERVER_URL=http://localhost:${webappPort}.`;
}

/** The port a URL connects to: its explicit port, else 443/80 by scheme. */
function effectivePort(serverUrl: string): number | undefined {
  try {
    const url = new URL(serverUrl);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

function unusableTokenMessage(resolution: UnusableResolution): string {
  switch (resolution.kind) {
    case "remote-url":
      return remoteServerUrlMessage();
    case "unreadable":
      return unreadableSettingsMessage(resolution.errorKind);
    case "missing":
      return missingCliApiTokenMessage();
  }
}

/** The hint printed when the server rejects a token read from settings.json. */
export function rejectedSettingsTokenMessage(): string {
  return `The server rejected the token read from ${configuration.settingsFile}: set CLI_API_TOKEN, or fix cliApiToken in that file (\`hapi auth login\` saves it there).`;
}

/** The help-text line describing where these commands read their token. */
export function cliApiTokenSourcesNote(): string {
  return `Authentication uses the CLI_API_TOKEN environment variable, else cliApiToken in ${configuration.settingsFile} when HAPI_SERVER_URL is unset or a loopback address`;
}

/** The error thrown when POST /api/auth answers 2xx without a token. */
export function notHapimaticServerMessage(status: number): string {
  const url = configuration.serverUrl;
  return `${url}/api/auth answered HTTP ${status} without a token. Is ${url} a Hapimatic server? Check HAPI_SERVER_URL.`;
}

/**
 * Resolve the token and exchange it for a JWT via `POST /api/auth`. Exits with
 * `exitCode` before any request when no usable token is found — none set, a
 * non-loopback server URL without CLI_API_TOKEN, or an unreadable
 * settings.json (#5136) — printing one line that names the cause
 * (`hapi capabilities` passes 2, its documented tool-error code).
 *
 * A failed exchange rethrows the AxiosError with the token removed (see
 * {@link redactAuthRequest}), so a caller that lets it escape never prints it.
 * For a token that came from settings.json it first prints the line the
 * caller's own error cannot: {@link rejectedSettingsTokenMessage} on a 401, and
 * {@link unreachableServerMessage} when no HTTP response arrived (#5136). A 2xx
 * reply without a non-empty string `token` (a server that is not Hapimatic)
 * throws {@link notHapimaticServerMessage} instead of returning `undefined`
 * (#5098).
 */
export async function authenticateCli(exitCode = 1): Promise<string> {
  const resolution = await resolveCliApiToken();
  if (
    resolution.kind === "missing" ||
    resolution.kind === "remote-url" ||
    resolution.kind === "unreadable"
  ) {
    console.error(unusableTokenMessage(resolution));
    process.exit(exitCode);
  }
  const { token } = resolution;
  const fromSettings = resolution.kind === "settings";
  const webappPort =
    resolution.kind === "settings" ? resolution.webappPort : undefined;

  let resp: AxiosResponse<unknown>;
  try {
    // A settings token goes only to the loopback server the URL names: no
    // ambient proxy (HTTP_PROXY / ALL_PROXY have no loopback exemption) and no
    // redirect (axios re-sends the POST body to the Location on a 307/308).
    // An env token keeps both, since a remote server may sit behind a proxy.
    resp = await axios.post(
      `${configuration.serverUrl}/api/auth`,
      { accessToken: token },
      fromSettings
        ? { timeout: 10_000, proxy: false, maxRedirects: 0 }
        : { timeout: 10_000 }
    );
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (fromSettings && error.response?.status === 401) {
        console.error(rejectedSettingsTokenMessage());
      }
      if (fromSettings && !error.response) {
        console.error(
          unreachableServerMessage(describeErrorKind(error), webappPort)
        );
      }
      redactAuthRequest(error);
    }
    throw error;
  }

  // A Hapimatic server always answers `{ token: <JWT>, user }`. Anything else
  // (an HTML page, `{}`) means HAPI_SERVER_URL points somewhere else; returning
  // `undefined` would surface as a confusing later 401 or a false success.
  const reply: unknown = resp.data;
  const jwt =
    reply !== null && typeof reply === "object"
      ? (reply as { token?: unknown }).token
      : undefined;
  if (typeof jwt !== "string" || jwt === "") {
    throw new Error(notHapimaticServerMessage(resp.status));
  }
  return jwt;
}

/**
 * Remove the token from a failed `/api/auth` error. It sits in two places:
 * `config.data` (the JSON body) and `request`, whose follow-redirects buffers
 * keep the written body when the server is unreachable. Every current caller
 * catches the error and prints a one-line summary (`hapi federation` since
 * #5098), but an error that escapes reaches the runtime, which prints the whole
 * object to stderr, so the token is removed for any future caller that lets it
 * escape. The message, status and response stay, so callers'
 * `axios.isAxiosError` branches still work.
 */
function redactAuthRequest(error: AxiosError): void {
  if (error.config) error.config.data = REDACTED;
  if (error.response?.config) error.response.config.data = REDACTED;
  error.request = undefined;
  if (error.response) error.response.request = undefined;
}
