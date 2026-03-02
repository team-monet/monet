import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/schema/platform.ts", "./src/schema/tenant.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
