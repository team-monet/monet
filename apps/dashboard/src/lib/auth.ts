import NextAuth from "next-auth";
import type { NextAuthConfig, User, Profile } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { desc, eq } from "drizzle-orm";
import {
  tenantSchemaNameFromId,
  tenantUsers,
  platformAdmins,
  platformOauthConfigs,
  tenantOauthConfigs,
  tenants,
  withTenantDrizzleScope,
} from "@monet/db";
import { normalizeTenantSlug } from "@monet/types";
import { redirect } from "next/navigation";
import { db, getSqlClient } from "./db";
import { decrypt } from "./crypto";
import { finalizePlatformInitialization } from "./bootstrap";
import {
  fetchOidcDiscoveryDocument,
  resolveOidcProviderConfig,
  resolveOidcIssuerForServer,
  replaceUrlOrigin,
} from "./oidc";
import { upsertTenantUserFromLogin } from "./tenant-user-binding";
import { buildRefreshedToken } from "./auth-refresh";
import { REFRESH_ACCESS_TOKEN_ERROR } from "./session-errors";

interface ExtendedUser extends User {
  role?: string;
  tenantId?: string;
  scope?: "tenant" | "platform";
  emailVerified?: boolean;
}

interface ExtendedJWT {
  id: string;
  role: string | null;
  scope: "tenant" | "platform";
  tenantId?: string;
  name?: string | null;
  email?: string | null;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  error?: string;
}

const MISSING_RELATION_ERROR_CODE = "42P01";

function isMissingRelationError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === MISSING_RELATION_ERROR_CODE
  );
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

function isProfileEmailVerified(profile: Profile) {
  // Some IdPs send email_verified as the string "true" instead of a boolean.
  // Treat both as verified so admin nominations can be claimed on first login.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (profile as any).email_verified;
  return raw === true || raw === "true";
}

function isDevBypassEnabled() {
  const bypassEnabled = process.env.DEV_BYPASS_AUTH === "true";
  const allowInProduction = process.env.DASHBOARD_LOCAL_AUTH === "true";
  return (
    bypassEnabled &&
    (process.env.NODE_ENV === "development" || allowInProduction)
  );
}

async function refreshAccessToken(token: ExtendedJWT) {
  if (token.accessToken === "dev-bypass-token") {
    return {
      ...token,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  try {
    const [config] =
      token.scope === "platform"
        ? await db
            .select()
            .from(platformOauthConfigs)
            .orderBy(desc(platformOauthConfigs.createdAt))
            .limit(1)
        : await db
            .select()
            .from(tenantOauthConfigs)
            .where(eq(tenantOauthConfigs.tenantId, token.tenantId!))
            .limit(1);

    if (!config || !token.refreshToken) {
      throw new Error("Missing config or refresh token");
    }

    const discovery = await fetchOidcDiscoveryDocument(config.issuer);

    if (!discovery.token_endpoint) {
      throw new Error("OIDC discovery document is missing token_endpoint");
    }

    const serverIssuer = resolveOidcIssuerForServer(config.issuer);
    const tokenEndpoint = replaceUrlOrigin(
      discovery.token_endpoint,
      serverIssuer,
    );

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

    return buildRefreshedToken(token, refreshedTokens);
  } catch (error) {
    console.error("RefreshAccessTokenError", error);
    return {
      ...token,
      error: REFRESH_ACCESS_TOKEN_ERROR,
    };
  }
}

export const authConfig: NextAuthConfig = {
  providers: [],
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
  },
  callbacks: {
    async jwt({ token, user, account }) {
      if (user && account) {
        const extendedUser = user as ExtendedUser;

        if (extendedUser.scope === "platform") {
          const email = normalizeEmail(user.email);
          if (!email || !extendedUser.emailVerified) {
            throw new Error("Platform admin sign-in requires a verified email");
          }

          let [platformAdmin] = await db
            .select()
            .from(platformAdmins)
            .where(eq(platformAdmins.externalId, user.id!))
            .limit(1);

          if (!platformAdmin) {
            [platformAdmin] = await db
              .select()
              .from(platformAdmins)
              .where(eq(platformAdmins.email, email))
              .limit(1);
          }

          if (!platformAdmin) {
            throw new Error("Platform admin access has not been provisioned");
          }

          const [updatedAdmin] = await db
            .update(platformAdmins)
            .set({
              externalId: user.id!,
              displayName: user.name ?? platformAdmin.displayName,
              lastLoginAt: new Date(),
            })
            .where(eq(platformAdmins.id, platformAdmin.id))
            .returning();

          await finalizePlatformInitialization();

          return {
            id: updatedAdmin.id,
            role: "platform_admin",
            scope: "platform",
            name: updatedAdmin.displayName ?? user.name,
            email,
            accessToken: account.access_token || "platform-oauth-token",
            refreshToken:
              account.refresh_token || "platform-oauth-refresh-token",
            expiresAt:
              (account.expires_at as number) ??
              Math.floor(Date.now() / 1000) +
                ((account.expires_in as number) ?? 3600),
          } as ExtendedJWT;
        }

        const tenantId = extendedUser.tenantId;
        if (!tenantId) {
          throw new Error("No tenant ID found in user profile");
        }

        const dbUser = await upsertTenantUserFromLogin({
          tenantId,
          externalId: user.id!,
          displayName: user.name,
          email: user.email,
          emailVerified: extendedUser.emailVerified === true,
        });

        return {
          id: dbUser.id,
          role: dbUser.role,
          scope: "tenant",
          tenantId: dbUser.tenantId,
          name: dbUser.displayName ?? user.name ?? user.email,
          email: user.email,
          accessToken: account.access_token || "dev-bypass-token",
          refreshToken: account.refresh_token || "dev-bypass-refresh-token",
          expiresAt:
            (account.expires_at as number) ??
            Math.floor(Date.now() / 1000) +
              ((account.expires_in as number) ?? 3600),
        } as ExtendedJWT;
      }

      const extendedToken = token as unknown as ExtendedJWT;
      // Refresh token 60 seconds before it expires
      if (Date.now() < (extendedToken.expiresAt - 60) * 1000) {
        return token;
      }

      return refreshAccessToken(extendedToken) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    async session({ session, token }) {
      if (token && session.user) {
        const sessionUser = session.user as unknown as ExtendedUser;
        sessionUser.id = token.id as string;
        sessionUser.role = token.role as string;
        sessionUser.scope = token.scope as "tenant" | "platform";
        sessionUser.name = (token.name as string | null | undefined) ?? null;
        sessionUser.email = (token.email as string | null | undefined) ?? null;
        sessionUser.tenantId =
          token.scope === "tenant" ? (token.tenantId as string) : undefined;

        if (token.error) {
          (session as any).error = token.error; // eslint-disable-line @typescript-eslint/no-explicit-any
        }
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    signOut: "/signout",
  },
};

const authSecret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET;

const PROVIDER_CONFIG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const providerConfigCache = new Map<
  string,
  { data: Awaited<ReturnType<typeof resolveOidcProviderConfig>>; expiresAt: number }
>();

async function getCachedProviderConfig(issuer: string) {
  const cached = providerConfigCache.get(issuer);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  const config = await resolveOidcProviderConfig(issuer);
  providerConfigCache.set(issuer, {
    data: config,
    expiresAt: Date.now() + PROVIDER_CONFIG_CACHE_TTL,
  });
  return config;
}

const result = NextAuth(async (req) => {
  if (!authSecret) {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET environment variable is required",
    );
  }
  const providers = [];

  if (isDevBypassEnabled()) {
    providers.push(
      CredentialsProvider({
        id: "dev-bypass",
        name: "Dev Bypass",
        credentials: {
          orgSlug: { label: "Organization Slug", type: "text" },
        },
        async authorize(credentials) {
          const requestedOrgInput =
            typeof credentials?.orgSlug === "string" ? credentials.orgSlug : "";
          const requestedSlug = requestedOrgInput
            ? normalizeTenantSlug(requestedOrgInput)
            : "";

          if (!requestedSlug) return null;

          const [tenant] = await db
            .select()
            .from(tenants)
            .where(eq(tenants.slug, requestedSlug))
            .limit(1);
          if (!tenant) return null;

          const [user] = await withTenantDrizzleScope(
            getSqlClient(),
            tenantSchemaNameFromId(tenant.id),
            async (tenantDb) => tenantDb
              .select()
              .from(tenantUsers)
              .where(eq(tenantUsers.tenantId, tenant.id))
              .limit(1),
          );
          if (!user) return null;

          return {
            id: user.externalId,
            tenantId: tenant.id,
            role: user.role,
            scope: "tenant",
            name: user.displayName ?? "Local User",
            email: "local@example.com",
          } as ExtendedUser;
        },
      }),
    );
  }

  let platformConfig: (typeof platformOauthConfigs.$inferSelect) | undefined;
  try {
    [platformConfig] = await db
      .select()
      .from(platformOauthConfigs)
      .orderBy(desc(platformOauthConfigs.createdAt))
      .limit(1);
  } catch (error) {
    if (!isMissingRelationError(error)) {
      throw error;
    }
  }

  if (platformConfig) {
    const platformOidc = await getCachedProviderConfig(platformConfig.issuer);
    providers.push({
      id: "platform-oauth",
      name: "Monet Platform",
      type: "oidc" as const,
      issuer: platformOidc.browserIssuer,
      wellKnown: platformOidc.wellKnown,
      clientId: platformConfig.clientId,
      clientSecret: decrypt(platformConfig.clientSecretEncrypted),
      authorization: {
        url: platformOidc.authorization,
        params: { scope: "openid email profile offline_access" },
      },
      token: { url: platformOidc.token },
      ...(platformOidc.userinfo
        ? { userinfo: { url: platformOidc.userinfo } }
        : {}),
      profile(profile: Profile) {
        return {
          id: profile.sub || (profile as any).id, // eslint-disable-line @typescript-eslint/no-explicit-any
          name: profile.name,
          email: profile.email,
          emailVerified: isProfileEmailVerified(profile),
          role: "platform_admin",
          scope: "platform",
        } as ExtendedUser;
      },
    });
  }

  const tenantSlug =
    req?.nextUrl.searchParams.get("tenant") ||
    req?.cookies.get("tenant-slug")?.value;
  const normalizedTenantSlug = tenantSlug ? normalizeTenantSlug(tenantSlug) : "";

  if (normalizedTenantSlug) {
    const [tenant] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, normalizedTenantSlug))
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
        const tenantOidc = await getCachedProviderConfig(config.issuer);
        providers.push({
          id: "tenant-oauth",
          name: tenant.name,
          type: "oidc" as const,
          issuer: tenantOidc.browserIssuer,
          wellKnown: tenantOidc.wellKnown,
          clientId: config.clientId,
          clientSecret: decrypt(config.clientSecretEncrypted),
          authorization: {
            url: tenantOidc.authorization,
            params: { scope: "openid email profile offline_access" },
          },
          token: { url: tenantOidc.token },
          ...(tenantOidc.userinfo
            ? { userinfo: { url: tenantOidc.userinfo } }
            : {}),
          profile(profile: Profile) {
            return {
              id: profile.sub || (profile as any).id, // eslint-disable-line @typescript-eslint/no-explicit-any
              name: profile.name,
              email: profile.email,
              emailVerified: isProfileEmailVerified(profile),
              tenantId: tenant.id,
              scope: "tenant",
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
  if (sessionUser.scope !== "tenant" || sessionUser.role !== "tenant_admin") {
    throw new Error("Forbidden: Admin access required");
  }
  return session;
};

export const requirePlatformAdmin = async () => {
  const session = await getSession();
  if (!session) {
    redirect("/platform/login");
  }

  const sessionUser = session.user as ExtendedUser;
  if (
    sessionUser.scope !== "platform" ||
    sessionUser.role !== "platform_admin"
  ) {
    throw new Error("Forbidden: Platform admin access required");
  }

  return session;
};
