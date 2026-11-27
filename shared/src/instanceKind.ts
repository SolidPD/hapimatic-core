// SPDX-License-Identifier: AGPL-3.0-only
import { WORKTREE_PORT_MAX, WORKTREE_PORT_MIN } from "./worktreeMeta";

/**
 * The instance-kind classifier (issue #6756, TC1): is this Hapimatic instance a node's
 * REAL instance, a TEST instance (a worktree instance, a tester's temp home, the CI
 * integration daemon), or the operator's DEV instance?
 *
 * A test instance must start with an empty account list and copy no login: the daemon's
 * boot adoption of the machine-global account folders runs on a real instance only. The
 * rule names what a test instance LOOKS like; it never lists real homes, because real
 * homes differ by node and an allowlist would put fleet names into the open-source core.
 *
 * An instance is a TEST instance when ANY of these holds:
 *   (a) `declared-test`: a declared kind of `test`, from `<HAPI_HOME>/instance-kind` or
 *       `HAPI_INSTANCE_KIND`;
 *   (b) `wt-owner`: `HAPI_WT_OWNER_WORKTREE` is set and non-empty (every worktree launch
 *       sets it, scripts/hapi-worktree.sh);
 *   (c) `unit`: the process's systemd unit is `hapimatic-wt-<port>-daemon.service` or
 *       `-server.service`;
 *   (d) `port`: the server port is in WORKTREE_PORT_MIN..WORKTREE_PORT_MAX;
 *   (e) `home-name`: the data dir's basename starts with `.hapimatic-wt-` (on native
 *       Windows also the raw text's last segment, so a spelling rule (f) cannot place is
 *       still marked);
 *   (f) `home-shape`: the data dir is not a hidden directory directly inside the user's
 *       home (so `/tmp/...`, `/var/tmp/...`, `/run/user/...` and `~/scratch/x` are test
 *       homes). It passes when either the data dir's absolute path or its realpath sits
 *       directly under the user's home or under that home's realpath, so a symlinked home
 *       or a data dir that is a symlink to another disk stays real. On native Windows
 *       (`pathStyle: "win32"`, chosen by the reader) the same test reads drive-letter and
 *       UNC paths with either separator, without regard to ASCII letter case; a path it
 *       cannot place (drive-relative, root-relative, a `\\?\` or `\\.\` device path, a UNC
 *       path with no share, or a segment Win32 would rewrite or that holds `<>:"|?*`) never
 *       passes, so it stays a test home (#6981).
 *
 * A declared `real` lifts (d) and (f) (ER-D5: a self-hosted install with an unusual
 * `HAPI_HOME`, or a peer already on a worktree port); a declared `dev` lifts (f). Neither
 * lifts (a), (b), (c) or (e): no setting turns those test marks off, because the failure
 * they guard against is silent (a test instance holding real logins) while the opposite
 * failure is loud (a spawn refused for want of an account).
 *
 * The kind is DEV when the declared kind is `dev` and no test signal holds; every other
 * instance is REAL. When the file and the variable disagree, the more restrictive wins
 * (test, then dev, then real). An unknown declared value is ignored and named
 * `declared-invalid`.
 *
 * NODE-FREE (the web bundle may import it): the Node reader that gathers the inputs is
 * `./instanceKindReader`.
 */

/** The declaration file inside the instance's data dir: one line, `test` | `dev` | `real`. */
export const INSTANCE_KIND_FILE = "instance-kind";

/** The declaration's environment form; the file and the variable combine (most restrictive wins). */
export const HAPI_INSTANCE_KIND_ENV = "HAPI_INSTANCE_KIND";

/** Set by every worktree instance launch (scripts/hapi-worktree.sh) to the owning worktree. */
export const HAPI_WT_OWNER_WORKTREE_ENV = "HAPI_WT_OWNER_WORKTREE";

/**
 * The marker a test-instance daemon writes into `<HAPI_HOME>/accounts/` when it finds the
 * store empty (R7). Every later deletion of a test instance's logins requires it, so a store
 * that predates this work is never deleted by it.
 */
export const TEST_STORE_MARKER = "test-store.json";

/**
 * Files a daemon writes into `<HAPI_HOME>/accounts/` that hold no login and say nothing
 * about where the store came from (`host-chain-identity-pass.json`, the shared-chain
 * pass's first-pass record, written once, by the first shared-chain pass that finds it
 * absent; later passes only read it). They still block the marker (R7: no `*.json` file
 * at all), but they never make a store read as inherited (ER-D1), or a store
 * marked-to-be would flip to inherited at its second boot.
 */
export const TEST_STORE_BOOKKEEPING_FILES: readonly string[] = [
  "host-chain-identity-pass.json",
];

/**
 * A fixed string the compiled binary carries, so `scripts/hapi-worktree.sh` can tell a
 * binary that honours this classifier from an older one WITHOUT running it (Task 13,
 * ER-D2: an older binary handed an unknown subcommand falls through to the default Claude
 * command, which can start a daemon that adopts). Bump the trailing number only when the
 * classifier's contract changes incompatibly.
 */
export const INSTANCE_KIND_CLASSIFIER_SENTINEL =
  "hapi-instance-kind-classifier:1";

export type InstanceKind = "real" | "test" | "dev";

/** Which path rules apply: `win32` on native Windows, `posix` everywhere else. */
export type InstanceKindPathStyle = "posix" | "win32";

export type InstanceKindSignal =
  | "declared-test"
  | "wt-owner"
  | "unit"
  | "port"
  | "home-name"
  | "home-shape"
  | "declared-dev"
  | "declared-real"
  | "declared-invalid";

export interface InstanceKindInputs {
  /** The data dir the configuration resolves (leading `~` expanded); `null` = could not be resolved. */
  hapiHome: string | null;
  /** The data dir's realpath, when it can be read. */
  hapiHomeRealpath?: string | null;
  /** The user's home (`os.homedir()`). */
  userHome: string;
  /** The user's home's realpath, when it can be read. */
  userHomeRealpath?: string | null;
  /** The instance's server port; `null` when unknown. */
  serverPort: number | null;
  /** The process's systemd unit name; `null` when unknown or not under systemd. */
  unitName: string | null;
  /** The declared kind's raw values: the `instance-kind` file's first line and `HAPI_INSTANCE_KIND`. */
  declared: { file: string | null; env: string | null };
  /** `HAPI_WT_OWNER_WORKTREE`, raw. */
  wtOwnerWorktree: string | null;
  /** How to read the four paths: "win32" on native Windows, "posix" (the default when absent) elsewhere. */
  pathStyle?: InstanceKindPathStyle;
}

export interface InstanceKindResult {
  kind: InstanceKind;
  /** Every rule that matched, in rule order; lifted rules are not named. */
  signals: InstanceKindSignal[];
}

const WORKTREE_UNIT_RE = /^hapimatic-wt-\d+-(daemon|server)\.service$/;
const WORKTREE_HOME_PREFIX = ".hapimatic-wt-";
const RESTRICTIVENESS: readonly InstanceKind[] = ["test", "dev", "real"];

/** A declared value, trimmed and lowercased: a kind, `"invalid"`, or `null` when absent or empty. */
function parseDeclared(raw: string | null): InstanceKind | "invalid" | null {
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  return (RESTRICTIVENESS as readonly string[]).includes(value)
    ? (value as InstanceKind)
    : "invalid";
}

/**
 * An absolute POSIX path with `.`, `..`, repeated and trailing slashes resolved; `null` for a
 * path that is not absolute (a relative data dir is never "directly under the home"). A
 * backslash is an ordinary filename character here, and the comparison is case-sensitive.
 */
function normalizeAbsolute(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

/** `\\?\`, `\\.\` and their forward-slash forms: device paths, never placed. */
const WIN_DEVICE_RE = /^[\\/]{2}[.?](?:[\\/]|$)/;
const WIN_DRIVE_RE = /^([A-Za-z]):[\\/]/;
const WIN_UNC_RE = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?=[\\/]|$)/;
/** A segment Win32 would rewrite (trailing dot or space) or that cannot name a directory. */
const WIN_BAD_SEGMENT_RE = /[<>:"|?*]|[. ]$/;

/** ASCII-only lower case: NTFS folds case, but a JavaScript fold beyond A-Z could differ. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, c => c.toLowerCase());
}

/**
 * A Windows absolute path (drive `C:\` or UNC `\\server\share`, `\` or `/` separators) as
 * `/<root>/<part>/...`: ASCII lower case, `.` and `..` resolved without leaving the root, so
 * `splitParent` and the rules read it like a POSIX path (`C:\Users\op\.hapi` is
 * `/c:/users/op/.hapi`). `null` for a path it cannot place with certainty: drive-relative,
 * root-relative, a device path, a UNC path with no share, or a segment Win32 would rewrite.
 * A root never equals a segment: a drive root holds `:` and a UNC root holds `\`, and no
 * segment can hold either.
 */
function normalizeWin32Absolute(
  path: string | null | undefined
): string | null {
  if (!path || WIN_DEVICE_RE.test(path)) return null;
  let root: string;
  let rest: string;
  const drive = WIN_DRIVE_RE.exec(path);
  if (drive) {
    root = `${asciiLower(drive[1])}:`;
    rest = path.slice(2);
  } else {
    const unc = WIN_UNC_RE.exec(path);
    if (!unc) return null;
    const [whole, server, share] = unc;
    if (WIN_BAD_SEGMENT_RE.test(server) || WIN_BAD_SEGMENT_RE.test(share))
      return null;
    root = `\\\\${asciiLower(server)}\\${asciiLower(share)}`;
    rest = path.slice(whole.length);
  }
  const parts: string[] = [];
  for (const part of rest.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    if (WIN_BAD_SEGMENT_RE.test(part)) return null;
    parts.push(asciiLower(part));
  }
  return "/" + [root, ...parts].join("/");
}

/**
 * Rule (e) on native Windows for any spelling, including one the normaliser refuses: the raw
 * text's last segment as Win32 opens it (`.` and `..` resolved, then a last segment of only
 * dots or spaces dropped when the path does not end in a separator, then trailing dots and
 * spaces dropped, ASCII lower case). Without it a declared `real` or `dev` would lift a
 * worktree home spelled `.hapimatic-wt-3012.`, `.hapimatic-wt-3012\...` or
 * `\\?\C:\...\.hapimatic-wt-3012` (#6981). It only adds a test mark.
 */
function win32RawLastSegment(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts: string[] = [];
  for (const part of path.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  if (!/[\\/]$/.test(path) && /^[. ]+$/.test(parts.at(-1) ?? "")) parts.pop();
  const last = parts.at(-1) ?? "";
  let end = last.length;
  while (end > 0 && (last[end - 1] === "." || last[end - 1] === " ")) end--;
  return end > 0 ? asciiLower(last.slice(0, end)) : null;
}

function splitParent(path: string): { parent: string; base: string } {
  const cut = path.lastIndexOf("/");
  return {
    parent: cut <= 0 ? "/" : path.slice(0, cut),
    base: path.slice(cut + 1),
  };
}

/** Rule (f)'s pass: `candidate` is a hidden directory directly inside one of `homes`. */
function isHiddenDirectlyUnder(
  candidate: string | null,
  homes: readonly string[]
): boolean {
  if (candidate === null || candidate === "/") return false;
  const { parent, base } = splitParent(candidate);
  return base.startsWith(".") && base.length > 1 && homes.includes(parent);
}

/** The port of a server URL (explicit port only); `null` when absent or unparseable. */
export function serverPortFromUrl(
  url: string | null | undefined
): number | null {
  if (!url) return null;
  try {
    const port = new URL(url).port;
    if (port === "") return null;
    const n = Number(port);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** True when `port` is inside the worktree instance port range. */
export function isWorktreePort(port: number | null): boolean {
  return (
    port !== null &&
    Number.isInteger(port) &&
    port >= WORKTREE_PORT_MIN &&
    port <= WORKTREE_PORT_MAX
  );
}

/** Classify an instance from its inputs. Pure: no I/O, never throws. */
export function classifyInstance(
  inputs: InstanceKindInputs
): InstanceKindResult {
  const fromFile = parseDeclared(inputs.declared.file);
  const fromEnv = parseDeclared(inputs.declared.env);
  const valid = [fromFile, fromEnv].filter(
    (v): v is InstanceKind => v !== null && v !== "invalid"
  );
  const declared: InstanceKind | null =
    RESTRICTIVENESS.find(kind => valid.includes(kind)) ?? null;
  const invalid = fromFile === "invalid" || fromEnv === "invalid";

  // The style comes from the platform, never from the path text: on POSIX a backslash is a
  // filename character, so reading it as a separator would place `/home/op\.hapi` (a visible
  // directory in /home) directly in the home and read it real (#6981, premise P3).
  const normalize =
    inputs.pathStyle === "win32" ? normalizeWin32Absolute : normalizeAbsolute;
  const home = normalize(inputs.hapiHome);
  const homeReal = normalize(inputs.hapiHomeRealpath);
  const userHomes = [
    normalize(inputs.userHome),
    normalize(inputs.userHomeRealpath),
  ].filter((h): h is string => h !== null);

  const signals: InstanceKindSignal[] = [];
  if (declared === "test") signals.push("declared-test");
  if ((inputs.wtOwnerWorktree ?? "").trim() !== "") signals.push("wt-owner");
  if (inputs.unitName && WORKTREE_UNIT_RE.test(inputs.unitName.trim()))
    signals.push("unit");
  if (declared !== "real" && isWorktreePort(inputs.serverPort))
    signals.push("port");
  const win32RawName =
    inputs.pathStyle === "win32" &&
    [inputs.hapiHome, inputs.hapiHomeRealpath].some(
      p => win32RawLastSegment(p)?.startsWith(WORKTREE_HOME_PREFIX) === true
    );
  if (
    win32RawName ||
    [home, homeReal].some(
      p => p !== null && splitParent(p).base.startsWith(WORKTREE_HOME_PREFIX)
    )
  )
    signals.push("home-name");
  // A data dir that could not be resolved (`null`) counts as absent; a relative one is
  // present but never "directly under the home", so it is a test home.
  if (
    (inputs.hapiHome ?? "") !== "" &&
    declared !== "real" &&
    declared !== "dev" &&
    !isHiddenDirectlyUnder(home, userHomes) &&
    !isHiddenDirectlyUnder(homeReal, userHomes)
  )
    signals.push("home-shape");

  const isTest = signals.length > 0;
  if (declared === "dev") signals.push("declared-dev");
  if (declared === "real") signals.push("declared-real");
  if (invalid) signals.push("declared-invalid");

  const kind: InstanceKind = isTest
    ? "test"
    : declared === "dev"
      ? "dev"
      : "real";
  return { kind, signals };
}

/** `kind=<kind> (signals: <list>)`, the one boot log line's body (`none` when no rule matched). */
export function describeInstanceKind(result: InstanceKindResult): string {
  return `kind=${result.kind} (signals: ${
    result.signals.length > 0 ? result.signals.join(", ") : "none"
  })`;
}
