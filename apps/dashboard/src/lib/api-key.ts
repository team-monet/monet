import { randomBytes, scryptSync } from "node:crypto";

const KEY_PREFIX = "mnt_";

export interface HashedApiKey {
  hash: string;
  salt: string;
}

/**
 * Generate a new API key for an agent.
 * Format: mnt_<agentId-base64url>.<random-base64url>
 */
export function generateApiKey(agentId: string): string {
  const agentPart = Buffer.from(agentId).toString("base64url");
  const secretPart = randomBytes(32).toString("base64url");
  return `${KEY_PREFIX}${agentPart}.${secretPart}`;
}

const SCRYPT_PREFIX = "scrypt:";
const SCRYPT_KEYLEN = 64;

/**
 * Hash an API key with a random salt using scrypt.
 */
export function hashApiKey(rawKey: string): HashedApiKey {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(rawKey, salt, SCRYPT_KEYLEN, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { hash: `${SCRYPT_PREFIX}${derived}`, salt };
}
