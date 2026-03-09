import { and, asc, eq } from "drizzle-orm";
import {
  agentGroups,
  humanGroups,
  humanGroupAgentGroupPermissions,
  humanGroupMembers,
} from "@monet/db";
import { db } from "./db";

export async function listAllowedAgentGroupsForUserByHumanGroups(
  tenantId: string,
  userId: string,
) {
  return db
    .selectDistinct({
      id: agentGroups.id,
      name: agentGroups.name,
    })
    .from(humanGroupMembers)
    .innerJoin(
      humanGroupAgentGroupPermissions,
      eq(
        humanGroupAgentGroupPermissions.humanGroupId,
        humanGroupMembers.humanGroupId,
      ),
    )
    .innerJoin(
      agentGroups,
      eq(agentGroups.id, humanGroupAgentGroupPermissions.agentGroupId),
    )
    .innerJoin(
      humanGroups,
      eq(humanGroups.id, humanGroupMembers.humanGroupId),
    )
    .where(
      and(
        eq(humanGroupMembers.userId, userId),
        eq(humanGroups.tenantId, tenantId),
        eq(agentGroups.tenantId, tenantId),
      ),
    )
    .orderBy(asc(agentGroups.name));
}
