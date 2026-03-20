import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_PREFIX = "mnt_";

export interface ParsedApiKey {
  agentId: string;
  secret: string;
}

export interface HashedApiKey {
  hash: string;
  salt: string;
}

/**
 * Generate a new API key for an agent.
 * Format: mnt_<agentId-base64url>.<random-base64url>
 * The agent ID is embedded for O(1) DB lookup.
 */
export function generateApiKey(agentId: string): string {
  const agentPart = Buffer.from(agentId).toString("base64url");
  const secretPart = randomBytes(32).toString("base64url");
  return `${KEY_PREFIX}${agentPart}.${secretPart}`;
}

/**
 * Parse an API key string into its agent ID and secret components.
 * Returns null if the key format is invalid.
 */
export function parseApiKey(rawKey: string): ParsedApiKey | null {
  if (!rawKey.startsWith(KEY_PREFIX)) return null;

  const body = rawKey.slice(KEY_PREFIX.length);
  const dotIndex = body.indexOf(".");
  if (dotIndex === -1) return null;

  const agentPart = body.slice(0, dotIndex);
  const secret = body.slice(dotIndex + 1);

  if (!agentPart || !secret) return null;

  try {
    const agentId = Buffer.from(agentPart, "base64url").toString("utf-8");
    if (!agentId) return null;
    return { agentId, secret };
  } catch {
    return null;
  }
}

const SCRYPT_PREFIX = "scrypt:";
const SCRYPT_KEYLEN = 64;

/**
 * Hash an API key with a random salt using scrypt (slow hash).
 * Used when storing a new key.
 */
export function hashApiKey(rawKey: string): HashedApiKey {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(rawKey, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash: `${SCRYPT_PREFIX}${derived}`, salt };
}

/**
 * Hash an API key with a known salt.
 * Detects hash format: scrypt-prefixed hashes use scrypt, others use legacy SHA-256.
 */
export function hashApiKeyWithSalt(rawKey: string, salt: string, storedHash?: string): string {
  if (storedHash && !storedHash.startsWith(SCRYPT_PREFIX)) {
    // Legacy SHA-256 path for existing keys
    return createHash("sha256")
      .update(salt + rawKey)
      .digest("hex");
  }
  const derived = scryptSync(rawKey, salt, SCRYPT_KEYLEN).toString("hex");
  return `${SCRYPT_PREFIX}${derived}`;
}

/**
 * Constant-time comparison of two hash strings.
 * Prevents timing attacks on API key validation.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validate an incoming API key against a stored hash and salt.
 */
export function validateApiKey(
  rawKey: string,
  storedHash: string,
  storedSalt: string,
): boolean {
  const computedHash = hashApiKeyWithSalt(rawKey, storedSalt, storedHash);
  return constantTimeCompare(computedHash, storedHash);
}
