import { and, asc, eq } from "drizzle-orm";
import {
  agentGroups,
  userGroups,
  userGroupAgentGroupPermissions,
  userGroupMembers,
} from "@monet/db";
import { db } from "./db";

export async function listAllowedAgentGroupsForUserByUserGroups(
  tenantId: string,
  userId: string,
) {
  return db
    .selectDistinct({
      id: agentGroups.id,
      name: agentGroups.name,
    })
    .from(userGroupMembers)
    .innerJoin(
      userGroupAgentGroupPermissions,
      eq(
        userGroupAgentGroupPermissions.userGroupId,
        userGroupMembers.userGroupId,
      ),
    )
    .innerJoin(
      agentGroups,
      eq(agentGroups.id, userGroupAgentGroupPermissions.agentGroupId),
    )
    .innerJoin(
      userGroups,
      eq(userGroups.id, userGroupMembers.userGroupId),
    )
    .where(
      and(
        eq(userGroupMembers.userId, userId),
        eq(userGroups.tenantId, tenantId),
        eq(agentGroups.tenantId, tenantId),
      ),
    )
    .orderBy(asc(agentGroups.name));
}
