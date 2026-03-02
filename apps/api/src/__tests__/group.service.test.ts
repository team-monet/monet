import { describe, it, expect } from "vitest";
import { isTenantAdmin, isGroupAdminOrAbove } from "../services/group.service.js";

describe("role helpers", () => {
  describe("isTenantAdmin", () => {
    it("returns true for tenant_admin", () => {
      expect(isTenantAdmin("tenant_admin")).toBe(true);
    });

    it("returns false for group_admin", () => {
      expect(isTenantAdmin("group_admin")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isTenantAdmin(null)).toBe(false);
    });

    it("returns false for user", () => {
      expect(isTenantAdmin("user")).toBe(false);
    });
  });

  describe("isGroupAdminOrAbove", () => {
    it("returns true for tenant_admin", () => {
      expect(isGroupAdminOrAbove("tenant_admin")).toBe(true);
    });

    it("returns true for group_admin", () => {
      expect(isGroupAdminOrAbove("group_admin")).toBe(true);
    });

    it("returns false for user", () => {
      expect(isGroupAdminOrAbove("user")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isGroupAdminOrAbove(null)).toBe(false);
    });
  });
});
