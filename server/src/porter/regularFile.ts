// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Read a destination path without ever blocking on, or reading, a special
 * file (#5759).
 *
 * The plan's conflict read, the commit's backup copy of a non-link, the MCP
 * merge and the hook validator's `settings.json` and registry reads all read
 * files at the destination, and before #5759 they opened what they found
 * without checking its type (the backup already skipped a link to a
 * non-regular target, #4146). Opening a FIFO blocks until a writer appears
 * (under the import lock, for the commit-side readers), and reading a device
 * such as `/dev/zero` never ends. {@link readDestination} stats the path first
 * and does not open a FIFO, socket or device it sees there. It then reads a
 * regular file through one `O_NONBLOCK` descriptor whose `fstat` is checked
 * again, so a FIFO or device swapped in after the stat is refused unread (a
 * FIFO's `O_NONBLOCK` open does not block; a device's open still runs its
 * driver, with `O_NONBLOCK` and `O_NOCTTY` set).
 */
import { constants, type Stats } from "node:fs";
import { lstat, open, stat, type FileHandle } from "node:fs/promises";

/** A FIFO, socket or character/block device: a node the porter never reads. */
export function isSpecialFile(st: Stats): boolean {
  return (
    st.isFIFO() || st.isSocket() || st.isCharacterDevice() || st.isBlockDevice()
  );
}

/** Fixed text naming a special file's kind, for refusal messages. */
export function describeSpecialFile(st: Stats): string {
  if (st.isFIFO()) return "a FIFO (named pipe)";
  if (st.isSocket()) return "a socket";
  return "a device";
}

/** What {@link readDestination} found at a path. */
export type DestinationRead =
  | { kind: "absent" }
  | { kind: "special"; what: string }
  | { kind: "file"; content: Buffer; mode: number };

const ABSENT: DestinationRead = { kind: "absent" };

/**
 * Read `path` as a regular file without blocking on, or reading, a special
 * file (#5759).
 *
 *  - Absent (ENOENT, at the stat or at the open) → `{ kind: "absent" }`.
 *  - A FIFO, socket or device → `{ kind: "special" }`, never opened when the
 *    stat sees it. One swapped in after the stat is opened but never read:
 *    the `O_NONBLOCK` open of a FIFO or device returns and its `fstat` is
 *    checked, and an open that fails ENXIO (a socket on Linux, or a device
 *    node with no driver) is read as special. On macOS a socket's open fails
 *    EOPNOTSUPP instead, which propagates as an error; neither blocks.
 *  - A regular file → its bytes and its permission bits (`mode & 0o7777`,
 *    from the descriptor's `fstat`).
 *  - Every other error propagates as `readFile`'s did: ELOOP, ENOTDIR,
 *    EACCES, and EISDIR for a directory, which is opened and fails at the
 *    read (not refused as special), so a caller that relied on that error
 *    keeps it.
 *
 * `nofollow` uses `lstat` and `O_NOFOLLOW`, for a caller that has already
 * `lstat`ed a non-link: a link swapped in since then fails ELOOP.
 */
export async function readDestination(
  path: string,
  opts: { nofollow?: boolean } = {}
): Promise<DestinationRead> {
  let st: Stats;
  try {
    st = await (opts.nofollow ? lstat(path) : stat(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    throw err;
  }
  if (isSpecialFile(st))
    return { kind: "special", what: describeSpecialFile(st) };

  let fh: FileHandle;
  try {
    fh = await open(
      path,
      // O_NOCTTY: a tty swapped in after the stat must not become the
      // server's controlling terminal before the fstat refuses it.
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        constants.O_NOCTTY |
        (opts.nofollow ? constants.O_NOFOLLOW : 0)
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return ABSENT;
    // ENXIO: a socket (on Linux) or a device node with no driver, swapped in
    // after the stat.
    if (code === "ENXIO") {
      return { kind: "special", what: "a socket or device" };
    }
    throw err;
  }
  try {
    const fst = await fh.stat();
    if (isSpecialFile(fst)) {
      return { kind: "special", what: describeSpecialFile(fst) };
    }
    const content = await fh.readFile();
    return { kind: "file", content, mode: fst.mode & 0o7777 };
  } finally {
    // The descriptor is read-only, so a close error loses nothing; it must
    // not replace the real outcome (the bytes, the special result, or the
    // stat or read error).
    await fh.close().catch(() => {});
  }
}
