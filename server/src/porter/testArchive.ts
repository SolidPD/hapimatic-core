// SPDX-License-Identifier: AGPL-3.0-only
import { gzipSync } from "node:zlib";
import { Encrypter } from "age-encryption";
import {
  PORTER_SCHEMA_VERSION,
  type PorterManifest,
} from "@hapi/protocol/porter";

/**
 * Test-only fixtures for the Configuration Porter import path (issue #2343).
 *
 * A hand-rolled POSIX-tar WRITER that mirrors the hand-rolled reader
 * (`tarArchive.ts`), so fixtures exercise the exact byte format the parser
 * claims to support — including real symlink members for the zip-slip tests. No
 * `tar` npm dependency. Imported ONLY by `*.test.ts`, so it tree-shakes out of
 * the production binary.
 */

export interface TarMember {
  path: string;
  content?: Buffer | string;
  mode?: number;
  /** POSIX tar typeflag. "0"=file (default), "5"=dir, "2"=symlink, "1"=hardlink. */
  typeflag?: string;
  /** Link target for a symlink/hardlink member. */
  linkname?: string;
  // --- #4285: hostile-header overrides (defaults keep the POSIX output) ---
  /** Magic at offset 257: "posix" (`ustar\0` + `00`, the default), "gnu"
   * (`ustar  \0`), "none" (eight NULs, a v7 header), or raw 8 bytes. */
  magic?: "posix" | "gnu" | "none" | Buffer;
  /** The two version bytes at 263, overriding the magic's own. */
  version?: string;
  /** Bytes for the 155-byte ustar prefix slot at 345 (may carry NULs). */
  prefix?: string | Buffer;
  /** 12 bytes replacing the octal size field (base-256 / garbage cases). */
  rawSize?: Buffer;
  /** Write a checksum one higher than the real one. */
  badChecksum?: true;
}

/** Write an octal numeric tar field: (len-1) zero-padded octal digits + NUL. */
function octalField(n: number, len: number): Buffer {
  return Buffer.from(n.toString(8).padStart(len - 1, "0") + "\0", "ascii");
}

/** The 8 magic + version bytes (offset 257) a {@link TarMember} asks for. */
function magicBytes(m: TarMember): Buffer {
  const magic =
    m.magic === undefined || m.magic === "posix"
      ? Buffer.from("ustar\x0000", "latin1")
      : m.magic === "gnu"
        ? Buffer.from("ustar  \0", "latin1")
        : m.magic === "none"
          ? Buffer.alloc(8, 0)
          : m.magic;
  const out = Buffer.alloc(8, 0);
  magic.copy(out, 0, 0, 8);
  if (m.version !== undefined) out.write(m.version.slice(0, 2), 6, "latin1");
  return out;
}

/**
 * A pax extended-header body (#4285) with correct BYTE-length records:
 * `<len> <key>=<value>\n`, where `len` counts every byte of the record,
 * its own digits included.
 */
export function paxBody(records: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(records)) {
    const rest = Buffer.from(` ${key}=${value}\n`, "utf8");
    let len = rest.byteLength + 1;
    while (String(len).length + rest.byteLength !== len) len++;
    parts.push(Buffer.concat([Buffer.from(String(len), "ascii"), rest]));
  }
  return Buffer.concat(parts);
}

/** The local `tar` when it is GNU tar, else null (#4285 real-tar checks). */
export function findGnuTar(): string | null {
  const tar = Bun.which("tar");
  if (!tar) return null;
  const version = Bun.spawnSync([tar, "--version"]).stdout.toString();
  return version.includes("GNU tar") ? tar : null;
}

/** Build an uncompressed POSIX (ustar) tar from `members`. */
export function buildTar(members: TarMember[]): Buffer {
  const blocks: Buffer[] = [];
  for (const m of members) {
    const isBodyless =
      m.typeflag === "5" || m.typeflag === "2" || m.typeflag === "1";
    const content = isBodyless
      ? Buffer.alloc(0)
      : Buffer.isBuffer(m.content)
        ? m.content
        : Buffer.from(m.content ?? "", "utf8");

    const header = Buffer.alloc(512, 0);
    header.write(m.path.slice(0, 100), 0, "utf8"); // name
    octalField(m.mode ?? 0o644, 8).copy(header, 100); // mode
    octalField(0, 8).copy(header, 108); // uid
    octalField(0, 8).copy(header, 116); // gid
    (m.rawSize ?? octalField(content.length, 12)).copy(header, 124, 0, 12); // size
    octalField(0, 12).copy(header, 136); // mtime
    header.write(m.typeflag ?? "0", 156, "ascii"); // typeflag
    if (m.linkname) header.write(m.linkname.slice(0, 100), 157, "utf8");
    magicBytes(m).copy(header, 257); // magic + version
    if (m.prefix !== undefined) {
      const prefix = Buffer.isBuffer(m.prefix)
        ? m.prefix
        : Buffer.from(m.prefix, "latin1");
      prefix.copy(header, 345, 0, Math.min(prefix.byteLength, 155));
    }

    // Checksum: sum all bytes with the chksum field treated as 8 spaces.
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    if (m.badChecksum) sum += 1;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

    blocks.push(header);
    if (content.length > 0) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0)); // two zero blocks = end of archive
  return Buffer.concat(blocks);
}

/** Build a gzip-compressed `.tar.gz` from `members`. */
export function buildTarGz(members: TarMember[]): Uint8Array {
  return new Uint8Array(gzipSync(buildTar(members)));
}

/** Fill a valid {@link PorterManifest} object, overriding with `partial`. */
export function makeManifest(
  partial: Partial<PorterManifest> = {}
): PorterManifest {
  return {
    schemaVersion: PORTER_SCHEMA_VERSION,
    generatedAt: "2026-07-26T00:00:00Z",
    generator: { name: "test", version: "1.0.0" },
    skills: [],
    agents: [],
    commands: [],
    rules: [],
    outputStyles: [],
    settings: {},
    mcpServers: [],
    hooks: [],
    hookSupport: [],
    settingsScripts: [],
    omissions: [],
    ...partial,
  };
}

/** A `manifest.json` tar member carrying `manifest` (or arbitrary raw JSON). */
export function manifestMember(manifest: unknown): TarMember {
  return { path: "manifest.json", content: JSON.stringify(manifest) };
}

/** Encrypt a secret bundle to `recipient`, returning the `secrets.age` bytes. */
export async function encryptBundle(
  recipient: string,
  bundle: unknown
): Promise<Buffer> {
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  const out = await enc.encrypt(Buffer.from(JSON.stringify(bundle), "utf8"));
  return Buffer.from(out);
}
