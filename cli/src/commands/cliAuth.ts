// SPDX-License-Identifier: AGPL-3.0-only
import axios, { type AxiosError } from "axios";
import { configuration } from "@/configuration";
import { readSettings } from "@/persistence";

const REDACTED = "[redacted]";

/**
 * Resolve CLI_API_TOKEN for the non-interactive API commands (`hapi api`,
 * `hapi capabilities`, `hapi federation`) — issue #5080, #4498 Task 1.
 *
 * Priority: the CLI_API_TOKEN environment variable, then `cliApiToken` in
 * `<HAPI_HOME>/settings.json` (where `hapi auth login` and the server's first
 * run save it). Returns `""` when neither source has a token.
 *
 * This deliberately does NOT call `initializeToken()` (`@/ui/tokenInit`): that
 * prompts on a TTY, writes the prompt to stdout, and saves the token to
 * settings.json. These commands are non-interactive and scripts often parse
 * their stdout, so they must never prompt; they only read credentials, so they
 * must never write settings.json.
 */
export async function resolveCliApiToken(): Promise<string> {
  if (configuration.cliApiToken) {
    return configuration.cliApiToken;
  }

  const settings = await readSettings();
  if (settings.cliApiToken) {
    configuration._setCliApiToken(settings.cliApiToken);
    return settings.cliApiToken;
  }

  return "";
}

/** The error printed when neither token source is set. Names both sources. */
export function missingCliApiTokenMessage(): string {
  return `CLI_API_TOKEN is required: set the CLI_API_TOKEN environment variable, or cliApiToken in ${configuration.settingsFile} (\`hapi auth login\` saves it there).`;
}

/** The hint printed when the server rejects a token read from settings.json. */
export function rejectedSettingsTokenMessage(): string {
  return `The server rejected the token read from ${configuration.settingsFile}: set CLI_API_TOKEN, or fix cliApiToken in that file (\`hapi auth login\` saves it there).`;
}

/** The help-text line describing where these commands read their token. */
export function cliApiTokenSourcesNote(): string {
  return `Authentication uses the CLI_API_TOKEN environment variable, else cliApiToken in ${configuration.settingsFile}`;
}

/**
 * Resolve the token and exchange it for a JWT via `POST /api/auth`. Exits with
 * `exitCode` before any request when no token is set (`hapi capabilities`
 * passes 2, its documented tool-error code).
 *
 * A failed exchange rethrows the AxiosError with the token removed (see
 * {@link redactAuthRequest}), so a caller that lets it escape never prints it.
 * When the server rejects (401) a token that came from settings.json, it first
 * prints {@link rejectedSettingsTokenMessage}, because the caller's own error
 * line cannot say which source supplied the token.
 */
export async function authenticateCli(exitCode = 1): Promise<string> {
  const token = await resolveCliApiToken();
  if (!token) {
    console.error(missingCliApiTokenMessage());
    process.exit(exitCode);
  }
  // `configuration` reads the env token as `process.env.CLI_API_TOKEN || ""`,
  // and env wins, so any other token came from settings.json. (After a settings
  // fallback `configuration.cliApiToken` holds that token too, so it cannot tell.)
  const fromSettings = token !== process.env.CLI_API_TOKEN;

  try {
    const resp = await axios.post(
      `${configuration.serverUrl}/api/auth`,
      { accessToken: token },
      { timeout: 10_000 }
    );
    return resp.data.token as string;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (fromSettings && error.response?.status === 401) {
        console.error(rejectedSettingsTokenMessage());
      }
      redactAuthRequest(error);
    }
    throw error;
  }
}

/**
 * Remove the token from a failed `/api/auth` error. It sits in two places:
 * `config.data` (the JSON body) and `request`, whose follow-redirects buffers
 * keep the written body when the server is unreachable. `hapi federation
 * status` and `drain-node` call {@link authenticateCli} outside a `try`, so the
 * error reaches the runtime, which prints the whole object to stderr. The
 * message, status and response stay, so callers' `axios.isAxiosError` branches
 * still work.
 */
function redactAuthRequest(error: AxiosError): void {
  if (error.config) error.config.data = REDACTED;
  if (error.response?.config) error.response.config.data = REDACTED;
  error.request = undefined;
  if (error.response) error.response.request = undefined;
}
