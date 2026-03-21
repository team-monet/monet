import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@monet/types": path.resolve(__dirname, "../../packages/types/src/index.ts"),
      "@monet/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
    },
  },
});
