import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  parseApiKey,
  hashApiKey,
  hashApiKeyWithSalt,
  validateApiKey,
  constantTimeCompare,
} from "../services/api-key.service.js";

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
    it("produces a hash and salt", () => {
      const key = generateApiKey("agent-1");
      const { hash, salt } = hashApiKey(key);
      expect(hash).toBeTruthy();
      expect(salt).toBeTruthy();
      expect(hash).toHaveLength(64); // SHA-256 hex
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
      const { salt } = hashApiKey(key);
      const h1 = hashApiKeyWithSalt(key, salt);
      const h2 = hashApiKeyWithSalt(key, salt);
      expect(h1).toBe(h2);
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
