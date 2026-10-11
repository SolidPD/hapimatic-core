// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Instance-specific storage key utilities.
 *
 * When running multiple Hapimatic instances on the same hostname but different ports
 * (e.g., hapimatic-private on port 3008 and hapimatic-dev on port 3009), localStorage
 * and Cache API data can get confused. This utility ensures all storage keys include
 * the port number to guarantee complete data isolation between instances.
 *
 * @see https://github.com/MattStarfield/hapimatic-private/issues/50
 */

/**
 * Get the current instance's port identifier.
 * For default ports (80/443), returns the inferred port from the protocol.
 */
function getInstancePort(): string {
  if (typeof window === "undefined") return "80";
  const port = window.location.port;
  // For default ports (80/443), the port string is empty
  // Use the protocol to determine which default port
  if (!port) {
    return window.location.protocol === "https:" ? "443" : "80";
  }
  return port;
}

/**
 * Create an instance-specific localStorage key.
 * Appends the current port to the base key to prevent cross-instance contamination.
 *
 * @example getStorageKey('hapi:recentPaths') => 'hapi:recentPaths:3008'
 * @example getStorageKey('hapi_server_url') => 'hapi_server_url:3008'
 */
export function getStorageKey(baseKey: string): string {
  return `${baseKey}:${getInstancePort()}`;
}

/**
 * Create an instance-specific cache name for the Cache API.
 * Used by service workers to isolate cached data between instances.
 *
 * @example getCacheName('notification-preferences') => 'notification-preferences:3008'
 */
export function getCacheName(baseName: string): string {
  return `${baseName}:${getInstancePort()}`;
}

/**
 * Service worker variant that uses self.location instead of window.location.
 * Import this in sw.ts instead of the regular functions.
 */
export function getInstancePortForServiceWorker(): string {
  if (typeof self === "undefined" || !("location" in self)) return "80";
  // Use type assertion via unknown to handle both browser and service worker contexts
  const location = (self as unknown as { location: Location }).location;
  const port = location.port;
  if (!port) {
    return location.protocol === "https:" ? "443" : "80";
  }
  return port;
}

/**
 * Service worker variant of getCacheName.
 */
export function getCacheNameForServiceWorker(baseName: string): string {
  return `${baseName}:${getInstancePortForServiceWorker()}`;
}
