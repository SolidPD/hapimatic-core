// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Ed25519 key pairs in OpenSSH format for the companion (issue #4352): the
 * bench helper's host key (`privateSshd.ts`) and a cloud session's user key
 * (`vmClient.ts`). Returns text only; each caller writes the files with its
 * own permissions. Also checks a received key against the fingerprint the
 * server sent with it.
 */
import { generateKeyPairSync, randomInt } from "node:crypto";
import {
  base64UrlToBytes,
  ed25519LineFingerprint,
  formatEd25519PublicKey,
  formatOpenSshEd25519PrivateKey,
} from "@hapi/protocol/companion";

export type OpenSshKeyPair = {
  /** The `-----BEGIN OPENSSH PRIVATE KEY-----` file content. */
  privateKey: string;
  /** The `ssh-ed25519 <base64> <comment>` line. */
  publicKeyLine: string;
};

/** Generate a fresh Ed25519 key pair; `comment` goes into both halves. */
export function generateOpenSshKeyPair(comment: string): OpenSshKeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("ed25519 key export is incomplete");
  }
  const pub = base64UrlToBytes(jwk.x);
  return {
    privateKey: formatOpenSshEd25519PrivateKey(
      base64UrlToBytes(jwk.d),
      pub,
      randomInt(0, 0xffffffff),
      comment
    ),
    publicKeyLine: formatEd25519PublicKey(pub, comment),
  };
}

/**
 * The fingerprint of `line`, computed here. Throws when it differs from the
 * one the server sent, or when `line` is not a single ssh-ed25519 line. The
 * bench shows what it computed, so a swapped key cannot hide behind the
 * genuine fingerprint (the comparison the user makes must be able to fail).
 */
export async function confirmKeyFingerprint(
  line: string,
  claimed: string
): Promise<string> {
  if (/[\r\n]/.test(line.trim())) {
    throw new Error("expected a single public-key line");
  }
  const actual = await ed25519LineFingerprint(line);
  if (actual !== claimed) {
    throw new Error(
      `fingerprint mismatch: the server sent ${claimed}, the key is ${actual}`
    );
  }
  return actual;
}
