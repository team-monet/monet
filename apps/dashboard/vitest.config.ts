import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@monet/types": path.resolve(__dirname, "../../packages/types/src/index.ts"),
      "@monet/db": path.resolve(__dirname, "../../packages/db/src/index.ts"),
    },
  },
});
