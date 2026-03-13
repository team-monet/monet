export { createClient, type Database } from "./client";
export * from "./schema/index";
export {
  createTenantSchema,
  tenantSchemaNameFromId,
} from "./tenant-schema-manager";
export { withTenantScope } from "./scoped-client";
