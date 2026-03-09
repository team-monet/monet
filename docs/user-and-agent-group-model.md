# User And Agent Group Model

This document defines the preferred product and engineering language for Monet's tenant access model.

## Preferred Terms

Use these terms in product copy, docs, tickets, and API discussions:

- `User`: a person with a tenant login.
- `Role`: the user's privilege level inside a tenant. Current roles are `user`, `group_admin`, and `tenant_admin`.
- `User Group`: a collection of users used to grant access to agent groups.
- `Agent Group`: an operational grouping for agents. Agent groups control runtime scope such as memory, quotas, and policy attachment.
- `Default User Group`: the tenant-local `Everyone` group created or reused automatically on first login.

Avoid `human user`, `human group`, and similar terms in product-facing language.

## Technical Mapping

The current schema still uses older table names:

- `human_users` = users
- `human_groups` = user groups
- `human_group_members` = user-group memberships
- `human_group_agent_group_permissions` = user-group to agent-group permissions

Those names are implementation details and should not drive product terminology.

## Model

There are two separate control layers:

1. `Role`
   - Stored on the user record.
   - Controls platform and dashboard privileges.
   - Example: only `tenant_admin` can manage tenant-wide settings and register agents into any agent group.

2. `User Group`
   - Controls which agent groups a non-admin user may select during agent registration.
   - Users can belong to multiple user groups.
   - User-group permissions map to one or more agent groups.

These two layers are intentionally separate.

- A user's role answers: "What administrative actions may this person perform?"
- A user's group memberships answer: "Which agent groups may this person use?"

## Agent Registration Rules

### Non-admin users

- Can only create Human Proxy agents bound to themselves.
- Must select an agent group.
- Can only select agent groups explicitly allowed through their user-group memberships.

### Tenant admins

- Can create Human Proxy or Autonomous agents.
- Can bind Human Proxy agents to another user in the tenant.
- Can select any agent group in the tenant.

## First Login Behavior

On tenant login:

1. Monet creates or updates the tenant user record.
2. If the user has no user-group memberships yet, Monet ensures a tenant-local `Everyone` user group exists.
3. Monet adds the user to `Everyone`.

This guarantees every tenant user has at least one user-group membership.

## Important Operational Rule

The default `Everyone` group does not automatically grant access to any agent groups.

That means:

- users can log in successfully
- users will belong to `Everyone`
- users still cannot register agents until a tenant admin grants `Everyone` or another user group access to at least one agent group

This is deliberate. Membership and access are separate decisions.

## Recommended Tenant Setup

Use this baseline unless the tenant needs something more specialized:

1. Keep `Everyone` as the default user group for all tenant users.
2. Grant `Everyone` access to exactly one low-risk default agent group.
3. Create narrower user groups such as `Support`, `Ops`, or `Research` for elevated or specialized access.
4. Use `tenant_admin` and `group_admin` as roles, not as substitutes for user groups.

## Naming Guidance For Future Work

When adding new UI, API docs, issues, or product copy:

- say `user`, not `human user`
- say `user group`, not `human group`
- say `role` for `user`, `group_admin`, `tenant_admin`
- say `agent group` for agent runtime grouping

If we later do a schema rename, the target naming should follow the same model.
