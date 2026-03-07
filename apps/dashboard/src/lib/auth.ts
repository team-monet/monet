import NextAuth from "next-auth";
import type { NextAuthConfig, User, Profile } from "next-auth";
import { db } from "./db";
import { humanUsers, tenants, tenantOauthConfigs } from "@monet/db";
import { eq, and } from "drizzle-orm";
import { decrypt } from "./crypto";
import { ensureDashboardAgent } from "./dashboard-agent";
import CredentialsProvider from "next-auth/providers/credentials";

interface ExtendedUser extends User {
  role?: string;
  tenantId?: string;
}

interface ExtendedJWT {
  id: string;
  role: string | null;
  tenantId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

const TEST_ORG_SLUG = "test-org";
const TEST_ORG_NAME = "Test Org";
const LOCAL_TENANT_NAME = cleanEnvValue(process.env.LOCAL_TENANT_NAME) || TEST_ORG_NAME;
const MISSING_RELATION_ERROR_CODE = "42P01";

function isMissingRelationError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === MISSING_RELATION_ERROR_CODE
  );
}

function cleanEnvValue(value: string | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isDevBypassEnabled() {
  const bypassEnabled = process.env.DEV_BYPASS_AUTH !== "false";
  const allowInProduction = process.env.DASHBOARD_LOCAL_AUTH === "true";
  return bypassEnabled && (process.env.NODE_ENV === "development" || allowInProduction);
}

function normalizeTenantSlug(value: string) {
  return value.trim().toLowerCase();
}

function tenantLookupNameFromSlug(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return normalizeTenantSlug(trimmed) === TEST_ORG_SLUG ? LOCAL_TENANT_NAME : trimmed;
}

async function refreshAccessToken(token: ExtendedJWT) {
  if (token.accessToken === "dev-bypass-token") {
    return {
      ...token,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }
  try {
    const [config] = await db
      .select()
      .from(tenantOauthConfigs)
      .where(eq(tenantOauthConfigs.tenantId, token.tenantId))
      .limit(1);

    if (!config || !token.refreshToken) {
      throw new Error("Missing config or refresh token");
    }

    // OIDC Discovery
    const discoveryRes = await fetch(`${config.issuer}/.well-known/openid-configuration`);
    const discovery = await discoveryRes.json();
    const tokenEndpoint = discovery.token_endpoint;

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: decrypt(config.clientSecretEncrypted),
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }),
    });

    const refreshedTokens = await response.json();

    if (!response.ok) {
      throw refreshedTokens;
    }

    return {
      ...token,
      accessToken: refreshedTokens.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + refreshedTokens.expires_in,
      refreshToken: refreshedTokens.refresh_token ?? token.refreshToken, // Fall back to old refresh token
    };
  } catch (error) {
    console.error("RefreshAccessTokenError", error);
    return {
      ...token,
      error: "RefreshAccessTokenError",
    };
  }
}

export const authConfig: NextAuthConfig = {
  providers: [], // Dynamically populated
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // Extend to 30 days if using refresh tokens
  },
  callbacks: {
    async jwt({ token, user, account }) {
      if (user && account) {
        // During initial sign in
        const extendedUser = user as ExtendedUser;
        const tenantId = extendedUser.tenantId;

        if (!tenantId) {
          throw new Error("No tenant ID found in user profile");
        }

        let [dbUser] = await db
          .select()
          .from(humanUsers)
          .where(
            and(
              eq(humanUsers.externalId, user.id!),
              eq(humanUsers.tenantId, tenantId),
            ),
          )
          .limit(1);

        if (!dbUser) {
          const [newUser] = await db
            .insert(humanUsers)
            .values({
              externalId: user.id!,
              tenantId: tenantId,
              role: "user",
            })
            .returning();
          dbUser = newUser;
        }

        // Ensure dashboard agent exists
        await ensureDashboardAgent(
          dbUser.id,
          dbUser.externalId,
          dbUser.tenantId,
        );

        return {
          id: dbUser.id,
          role: dbUser.role,
          tenantId: dbUser.tenantId,
          accessToken: account.access_token || "dev-bypass-token",
          refreshToken: account.refresh_token || "dev-bypass-refresh-token",
          expiresAt: Math.floor(Date.now() / 1000) + ((account.expires_in as number) ?? 3600),
        } as unknown as ExtendedJWT;
      }

      const extendedToken = token as unknown as ExtendedJWT;
      // Return previous token if the access token has not expired yet
      if (Date.now() < extendedToken.expiresAt * 1000) {
        return token;
      }

      // Access token has expired, try to update it
      return refreshAccessToken(extendedToken) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    async session({ session, token }) {
      if (token && session.user) {
        const sessionUser = session.user as ExtendedUser;
        sessionUser.id = token.id as string;
        sessionUser.role = token.role as string;
        sessionUser.tenantId = token.tenantId as string;
        if (token.error) {
          (session as any).error = token.error; // eslint-disable-line @typescript-eslint/no-explicit-any
        }
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
};

const authSecret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "monet-dev-auth-secret");

const result = NextAuth(async (req) => {
  const providers = [];

  // Dev auth bypass
  if (isDevBypassEnabled()) {
    providers.push(
      CredentialsProvider({
        id: "dev-bypass",
        name: "Dev Bypass",
        credentials: {
          orgSlug: { label: "Organization Slug", type: "text" },
        },
        async authorize(credentials) {
          const requestedOrgInput = typeof credentials?.orgSlug === "string"
            ? credentials.orgSlug
            : "";
          const tenantLookupName = requestedOrgInput ? tenantLookupNameFromSlug(requestedOrgInput) : "";

          if (!tenantLookupName) return null;

          const [tenant] = await db
            .select()
            .from(tenants)
            .where(eq(tenants.name, tenantLookupName))
            .limit(1);
          
          if (!tenant) return null;

          const [user] = await db
            .select()
            .from(humanUsers)
            .where(eq(humanUsers.tenantId, tenant.id))
            .limit(1);
          
          if (!user) return null;

          return {
            id: user.externalId,
            tenantId: tenant.id,
            role: user.role,
            name: "Local User",
            email: "local@example.com",
          } as ExtendedUser;
        },
      })
    );
  }

  // Extract tenant slug from query, cookie or state
  const tenantSlug = req?.nextUrl.searchParams.get("tenant") || req?.cookies.get("tenant-slug")?.value;
  const tenantLookupName = tenantSlug ? tenantLookupNameFromSlug(tenantSlug) : "";

  if (tenantLookupName) {
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.name, tenantLookupName))
      .limit(1);

    if (tenant) {
      let config: (typeof tenantOauthConfigs.$inferSelect) | undefined;
      try {
        [config] = await db
          .select()
          .from(tenantOauthConfigs)
          .where(eq(tenantOauthConfigs.tenantId, tenant.id))
          .limit(1);
      } catch (error) {
        if (!isMissingRelationError(error)) {
          throw error;
        }
      }

      if (config) {
        providers.push({
          id: "tenant-oauth",
          name: tenant.name,
          type: "oidc" as const,
          issuer: config.issuer,
          clientId: config.clientId,
          clientSecret: decrypt(config.clientSecretEncrypted),
          authorization: { params: { scope: "openid email profile offline_access" } },
          // Pass tenant info to the user object in profile callback
          profile(profile: Profile) {
            return {
              id: profile.sub || (profile as any).id, // eslint-disable-line @typescript-eslint/no-explicit-any
              name: profile.name,
              email: profile.email,
              tenantId: tenant.id,
            } as ExtendedUser;
          },
        });
      }
    }
  }

  return {
    ...authConfig,
    providers,
    secret: authSecret,
  };
});


export const handlers = result.handlers;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const auth: any = result.auth;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const signIn: any = result.signIn;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const signOut: any = result.signOut;

export const getSession = () => auth();

import { redirect } from "next/navigation";

export const requireAuth = async () => {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
};

export const requireAdmin = async () => {
  const session = await requireAuth();
  const sessionUser = session.user as ExtendedUser;
  if (sessionUser.role !== "tenant_admin") {
    throw new Error("Forbidden: Admin access required");
  }
  return session;
};
