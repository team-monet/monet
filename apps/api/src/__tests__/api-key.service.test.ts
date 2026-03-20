import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  parseApiKey,
  hashApiKey,
  hashApiKeyWithSalt,
  validateApiKey,
  constantTimeCompare,
} from "../services/api-key.service";

describe("api-key.service", () => {
  describe("generateApiKey", () => {
    it("generates keys with the mnt_ prefix", () => {
      const key = generateApiKey("agent-1");
      expect(key.startsWith("mnt_")).toBe(true);
    });

    it("embeds the agent ID as base64url before the dot", () => {
      const key = generateApiKey("agent-1");
      const body = key.slice(4);
      const dotIndex = body.indexOf(".");
      expect(dotIndex).toBeGreaterThan(0);

      const agentPart = body.slice(0, dotIndex);
      const decoded = Buffer.from(agentPart, "base64url").toString("utf-8");
      expect(decoded).toBe("agent-1");
    });

    it("generates unique keys for the same agent", () => {
      const k1 = generateApiKey("agent-1");
      const k2 = generateApiKey("agent-1");
      expect(k1).not.toBe(k2);
    });
  });

  describe("parseApiKey", () => {
    it("parses a valid key", () => {
      const key = generateApiKey("my-agent");
      const parsed = parseApiKey(key);
      expect(parsed).not.toBeNull();
      expect(parsed!.agentId).toBe("my-agent");
      expect(parsed!.secret).toBeTruthy();
    });

    it("returns null for keys without mnt_ prefix", () => {
      expect(parseApiKey("invalid_key")).toBeNull();
    });

    it("returns null for keys without a dot separator", () => {
      expect(parseApiKey("mnt_nodot")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseApiKey("")).toBeNull();
    });

    it("returns null for keys with empty agent part", () => {
      expect(parseApiKey("mnt_.secret")).toBeNull();
    });

    it("returns null for keys with empty secret part", () => {
      const agentPart = Buffer.from("agent-1").toString("base64url");
      expect(parseApiKey(`mnt_${agentPart}.`)).toBeNull();
    });
  });

  describe("hashApiKey", () => {
    it("produces a scrypt hash and salt", () => {
      const key = generateApiKey("agent-1");
      const { hash, salt } = hashApiKey(key);
      expect(hash).toBeTruthy();
      expect(salt).toBeTruthy();
      expect(hash).toMatch(/^scrypt:/);
      expect(salt).toHaveLength(32); // 16 bytes hex
    });

    it("produces different salts for the same key", () => {
      const key = generateApiKey("agent-1");
      const h1 = hashApiKey(key);
      const h2 = hashApiKey(key);
      expect(h1.salt).not.toBe(h2.salt);
      expect(h1.hash).not.toBe(h2.hash);
    });
  });

  describe("hashApiKeyWithSalt", () => {
    it("produces a deterministic hash for the same key and salt", () => {
      const key = generateApiKey("agent-1");
      const { hash, salt } = hashApiKey(key);
      const h1 = hashApiKeyWithSalt(key, salt, hash);
      const h2 = hashApiKeyWithSalt(key, salt, hash);
      expect(h1).toBe(h2);
    });
  });

  describe("legacy SHA-256 compatibility", () => {
    it("validates keys hashed with legacy SHA-256", () => {
      const key = generateApiKey("agent-1");
      const salt = randomBytes(16).toString("hex");
      const legacyHash = createHash("sha256")
        .update(salt + key)
        .digest("hex");
      expect(validateApiKey(key, legacyHash, salt)).toBe(true);
    });

    it("rejects wrong key against legacy hash", () => {
      const key = generateApiKey("agent-1");
      const wrongKey = generateApiKey("agent-1");
      const salt = randomBytes(16).toString("hex");
      const legacyHash = createHash("sha256")
        .update(salt + key)
        .digest("hex");
      expect(validateApiKey(wrongKey, legacyHash, salt)).toBe(false);
    });
  });

  describe("validateApiKey", () => {
    it("returns true for a valid key against its hash", () => {
      const key = generateApiKey("agent-1");
      const { hash, salt } = hashApiKey(key);
      expect(validateApiKey(key, hash, salt)).toBe(true);
    });

    it("returns false for a wrong key", () => {
      const key = generateApiKey("agent-1");
      const { hash, salt } = hashApiKey(key);
      const wrongKey = generateApiKey("agent-1");
      expect(validateApiKey(wrongKey, hash, salt)).toBe(false);
    });

    it("returns false for a wrong salt", () => {
      const key = generateApiKey("agent-1");
      const { hash } = hashApiKey(key);
      expect(validateApiKey(key, hash, "wrong-salt")).toBe(false);
    });
  });

  describe("constantTimeCompare", () => {
    it("returns true for equal strings", () => {
      expect(constantTimeCompare("abc", "abc")).toBe(true);
    });

    it("returns false for different strings of same length", () => {
      expect(constantTimeCompare("abc", "xyz")).toBe(false);
    });

    it("returns false for strings of different lengths", () => {
      expect(constantTimeCompare("abc", "abcd")).toBe(false);
    });
  });
});
