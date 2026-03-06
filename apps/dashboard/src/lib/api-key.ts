import { randomBytes, createHash } from "node:crypto";

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

/**
 * Hash an API key with a random salt using SHA-256.
 */
export function hashApiKey(rawKey: string): HashedApiKey {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(salt + rawKey)
    .digest("hex");
  return { hash, salt };
}
