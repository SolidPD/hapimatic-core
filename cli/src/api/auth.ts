// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { configuration } from "@/configuration";

export function getAuthToken(): string {
  if (!configuration.cliApiToken) {
    throw new Error("CLI_API_TOKEN is required");
  }
  return configuration.cliApiToken;
}
