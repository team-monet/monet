import postgres from "postgres";
import { createApp } from "../../../src/app.js";
export declare function getTestSql(): postgres.Sql<{}>;
export declare function getTestDb(): import("drizzle-orm/postgres-js").PostgresJsDatabase<Record<string, unknown>> & {
    $client: postgres.Sql<{}>;
};
export declare function getTestApp(): import("hono").Hono<import("../../../src/middleware/context.js").AppEnv, import("hono/types").BlankSchema, "/">;
export declare function provisionTestTenant(app: ReturnType<typeof createApp>, name: string, adminSecret: string): Promise<{
    res: Response;
    body: Record<string, unknown>;
}>;
export declare function cleanupTestData(): Promise<void>;
export declare function closeTestDb(): Promise<void>;
//# sourceMappingURL=setup.d.ts.map