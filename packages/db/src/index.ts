export { createClient, type Database } from "./client.js";
export * from "./schema/index.js";
export {
  createTenantSchema,
  tenantSchemaNameFromId,
} from "./tenant-schema-manager.js";
export { withTenantScope } from "./scoped-client.js";
