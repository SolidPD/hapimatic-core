// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from "@/ui/logger";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "fs/promises";
import { createHash } from "crypto";
import { resolve } from "path";
import type { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import {
  isSafeMachinePath,
  isWorkingDirectoryRoot,
  validatePath,
} from "../pathSecurity";
import { getErrorMessage, rpcError } from "../rpcResponses";
import {
  READ_FILE_META,
  WRITE_FILE_META,
  CREATE_DIRECTORY_META,
  RENAME_PATH_META,
  DELETE_PATH_META,
} from "@/api/rpc/capabilityMeta";

// issue #2518: cap the bytes the CLI will base64 into a JSON RPC response. The
// read path holds the whole file in memory and base64-encodes it, so a 500 MB
// file would OOM the CLI *before* any client-side guard fires. Gating on
// stat().size BEFORE the read keeps oversized files out of the editor (R4) — the
// UI shows a download affordance instead.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

interface ReadFileRequest {
  path: string;
}

interface ReadFileResponse {
  success: boolean;
  content?: string;
  hash?: string;
  size?: number;
  tooLarge?: boolean;
  error?: string;
}

interface WriteFileRequest {
  path: string;
  content: string;
  expectedHash?: string | null;
}

interface WriteFileResponse {
  success: boolean;
  hash?: string;
  conflict?: boolean;
  error?: string;
}

// issue #2715: the V2 mutating file ops (create-folder / rename / delete).
interface CreateDirectoryRequest {
  path: string;
}

interface RenamePathRequest {
  path: string;
  newPath: string;
}

interface DeletePathRequest {
  path: string;
  // Recursive removal of a non-empty directory is an explicit, separately
  // confirmed opt-in from the UI (sweep finding 2715-5) — never the default.
  recursive?: boolean;
}

interface MutationResponse {
  success: boolean;
  error?: string;
}

/**
 * issue #2715: the shared pre-op guard for the three mutating file ops
 * (createDirectory / renamePath / deletePath). It runs V1's authoritative
 * CLI-side guard — `validatePath` (realpath symlink containment) +
 * `isSafeMachinePath` (secret deny-list) — then the R5 root-exclusion
 * (`isWorkingDirectoryRoot`). Returns the resolved absolute path on success or
 * an error string the caller maps to `rpcError`. Shared across all three ops so
 * the guard sequence cannot silently drift between them.
 */
function guardMutationTarget(
  targetPath: string,
  workingDirectory: string
): { resolved: string } | { error: string } {
  const validation = validatePath(targetPath, workingDirectory);
  if (!validation.valid) {
    return { error: validation.error ?? "Invalid file path" };
  }

  const resolved = resolve(workingDirectory, targetPath);

  // issue #2518: deny-list secret/credential files even inside the cwd.
  if (!isSafeMachinePath(resolved)) {
    return { error: `Access denied: '${targetPath}' is a restricted path` };
  }

  // issue #2715 / sweep finding 2715-1: validatePath permits target == cwd by
  // design; a mutating op (above all a recursive delete) of the session root
  // must not be allowed. Rejects "." / "./" / "a/.." and any alias of the root.
  if (isWorkingDirectoryRoot(targetPath, workingDirectory)) {
    return {
      error: `Access denied: '${targetPath}' targets the session working directory root`,
    };
  }

  return { resolved };
}

export function registerFileHandlers(
  rpcHandlerManager: RpcHandlerManager,
  workingDirectory: string
): void {
  rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(
    "readFile",
    async data => {
      logger.debug("Read file request:", data.path);

      const validation = validatePath(data.path, workingDirectory);
      if (!validation.valid) {
        return rpcError(validation.error ?? "Invalid file path");
      }

      const resolvedPath = resolve(workingDirectory, data.path);

      // issue #2518: deny-list secret/credential files even inside the cwd.
      if (!isSafeMachinePath(resolvedPath)) {
        return rpcError(`Access denied: '${data.path}' is a restricted path`);
      }

      try {
        // issue #2518: gate on size BEFORE reading (OOM guard, R4).
        const stats = await stat(resolvedPath);
        if (!stats.isFile()) {
          return rpcError(`Not a regular file: '${data.path}'`);
        }
        const size = stats.size;
        if (size > MAX_FILE_BYTES) {
          return rpcError(
            `File is too large to open in the browser (${size} bytes; limit ${MAX_FILE_BYTES}). Download it instead.`,
            { tooLarge: true, size }
          );
        }

        const buffer = await readFile(resolvedPath);
        const content = buffer.toString("base64");
        const hash = createHash("sha256").update(buffer).digest("hex");
        return { success: true, content, hash, size };
      } catch (error) {
        logger.debug("Failed to read file:", error);
        return rpcError(getErrorMessage(error, "Failed to read file"));
      }
    },
    READ_FILE_META
  );

  rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(
    "writeFile",
    async data => {
      logger.debug("Write file request:", data.path);

      const validation = validatePath(data.path, workingDirectory);
      if (!validation.valid) {
        return rpcError(validation.error ?? "Invalid file path");
      }

      // issue #2518: resolve against the session working directory. The read
      // handler already does this; the write handler historically used the raw
      // `data.path`, so a validated write landed relative to the CLI process cwd
      // (silent wrong-location write). Resolve once and use it everywhere below.
      const resolvedPath = resolve(workingDirectory, data.path);

      // issue #2518: deny-list secret/credential files even inside the cwd.
      if (!isSafeMachinePath(resolvedPath)) {
        return rpcError(`Access denied: '${data.path}' is a restricted path`);
      }

      try {
        const buffer = Buffer.from(data.content, "base64");
        // issue #2518: cap the write payload (defense-in-depth against a huge body).
        if (buffer.length > MAX_FILE_BYTES) {
          return rpcError(
            `Content too large to write (${buffer.length} bytes; limit ${MAX_FILE_BYTES}).`,
            { tooLarge: true, size: buffer.length }
          );
        }

        if (data.expectedHash !== null && data.expectedHash !== undefined) {
          try {
            const existingBuffer = await readFile(resolvedPath);
            const existingHash = createHash("sha256")
              .update(existingBuffer)
              .digest("hex");

            if (existingHash !== data.expectedHash) {
              // issue #2518: conflict → the route maps this to HTTP 409 and the
              // client offers a reload instead of clobbering the newer file.
              return rpcError(
                `File changed on disk since it was opened. Expected hash ${data.expectedHash}, found ${existingHash}.`,
                { conflict: true, hash: existingHash }
              );
            }
          } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code !== "ENOENT") {
              throw error;
            }
            return rpcError("File does not exist but hash was provided");
          }
        } else {
          try {
            await stat(resolvedPath);
            return rpcError("File already exists but was expected to be new");
          } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError.code !== "ENOENT") {
              throw error;
            }
          }
        }

        await writeFile(resolvedPath, buffer);

        const hash = createHash("sha256").update(buffer).digest("hex");

        return { success: true, hash };
      } catch (error) {
        logger.debug("Failed to write file:", error);
        return rpcError(getErrorMessage(error, "Failed to write file"));
      }
    },
    WRITE_FILE_META
  );

  // issue #2715: create-folder. validatePath + isSafeMachinePath + R5 root
  // check run inside guardMutationTarget before any fs op (fail closed).
  rpcHandlerManager.registerHandler<CreateDirectoryRequest, MutationResponse>(
    "createDirectory",
    async data => {
      logger.debug("Create directory request:", data.path);

      const guard = guardMutationTarget(data.path, workingDirectory);
      if ("error" in guard) {
        return rpcError(guard.error);
      }

      try {
        // recursive:false — the parent must already exist (the user creates a
        // folder inside a directory they are browsing), and an existing target
        // must fail loudly (EEXIST) rather than silently succeed.
        await mkdir(guard.resolved, { recursive: false });
        return { success: true };
      } catch (error) {
        logger.debug("Failed to create directory:", error);
        return rpcError(getErrorMessage(error, "Failed to create directory"));
      }
    },
    CREATE_DIRECTORY_META
  );

  // issue #2715: rename a file/folder. Guards BOTH legs (sweep finding 2715-6):
  // guarding only the destination would let rename(".env", "visible.txt") move a
  // secret out of the read-path deny-list; guarding only the source would let a
  // rename land the file on a denied/escaping destination.
  rpcHandlerManager.registerHandler<RenamePathRequest, MutationResponse>(
    "renamePath",
    async data => {
      logger.debug("Rename request:", data.path, "->", data.newPath);

      const source = guardMutationTarget(data.path, workingDirectory);
      if ("error" in source) {
        return rpcError(source.error);
      }
      const destination = guardMutationTarget(data.newPath, workingDirectory);
      if ("error" in destination) {
        return rpcError(destination.error);
      }

      try {
        // No silent clobber: refuse to overwrite an existing destination.
        try {
          await lstat(destination.resolved);
          return rpcError(`Destination '${data.newPath}' already exists`);
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== "ENOENT") {
            throw error;
          }
        }

        await rename(source.resolved, destination.resolved);
        return { success: true };
      } catch (error) {
        logger.debug("Failed to rename:", error);
        return rpcError(getErrorMessage(error, "Failed to rename"));
      }
    },
    RENAME_PATH_META
  );

  // issue #2715: delete a file/folder. Non-recursive by default (sweep finding
  // 2715-5): a non-empty directory surfaces ENOTEMPTY loudly unless the UI sets
  // the explicit, separately-confirmed `recursive` flag.
  rpcHandlerManager.registerHandler<DeletePathRequest, MutationResponse>(
    "deletePath",
    async data => {
      logger.debug("Delete request:", data.path, "recursive:", data.recursive);

      const guard = guardMutationTarget(data.path, workingDirectory);
      if ("error" in guard) {
        return rpcError(guard.error);
      }

      try {
        // lstat (not stat) so a symlink is classified as a symlink, not the
        // target it points at — we then unlink the LINK itself. (validatePath
        // already rejects a symlink whose realpath escapes the cwd.)
        const stats = await lstat(guard.resolved);

        if (stats.isDirectory()) {
          if (data.recursive === true) {
            await rm(guard.resolved, { recursive: true, force: false });
          } else {
            // Empty-only: ENOTEMPTY surfaces loudly instead of silently wiping
            // the directory's contents.
            await rmdir(guard.resolved);
          }
        } else {
          await unlink(guard.resolved);
        }

        return { success: true };
      } catch (error) {
        logger.debug("Failed to delete:", error);
        return rpcError(getErrorMessage(error, "Failed to delete"));
      }
    },
    DELETE_PATH_META
  );
}
