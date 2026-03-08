import { createHash, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { desc, eq, gt } from "drizzle-orm";
import {
  platformAdmins,
  platformInstallations,
  platformOauthConfigs,
  platformSetupSessions,
} from "@monet/db";
import { db } from "./db";
import { encrypt } from "./crypto";
import { resolveOidcIssuerForServer, validateOidcIssuer } from "./oidc";

export const SETUP_SESSION_COOKIE_NAME = "monet_setup_session";

type BootstrapStatus = {
  initialized: boolean;
  setupRequired: boolean;
};

type BootstrapExchangeResult = {
  setupSessionToken: string;
  expiresAt: string;
};

function getBootstrapApiUrl() {
  return process.env.INTERNAL_API_URL || "http://localhost:3001";
}

function hashTokenWithSalt(rawToken: string, salt: string) {
  return createHash("sha256").update(salt + rawToken).digest("hex");
}

function constantTimeCompare(a: string, b: string) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

function validateStoredToken(
  rawToken: string,
  storedHash: string,
  storedSalt: string,
) {
  return constantTimeCompare(hashTokenWithSalt(rawToken, storedSalt), storedHash);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  const response = await fetch(`${getBootstrapApiUrl()}/api/bootstrap/status`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to load platform bootstrap status");
  }

  return response.json();
}

export async function exchangeBootstrapToken(
  token: string,
): Promise<BootstrapExchangeResult> {
  const response = await fetch(`${getBootstrapApiUrl()}/api/bootstrap/exchange`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  const body = (await response.json().catch(() => null)) as
    | { message?: string }
    | null;

  if (!response.ok) {
    throw new Error(body?.message || "Failed to exchange bootstrap token");
  }

  return body as BootstrapExchangeResult;
}

export async function getSetupSessionToken() {
  const cookieStore = await cookies();
  return cookieStore.get(SETUP_SESSION_COOKIE_NAME)?.value ?? null;
}

export async function hasValidSetupSession() {
  const rawToken = await getSetupSessionToken();
  if (!rawToken) return false;

  const now = new Date();
  const sessions = await db
    .select()
    .from(platformSetupSessions)
    .where(gt(platformSetupSessions.expiresAt, now))
    .orderBy(desc(platformSetupSessions.createdAt));

  return sessions.some((session) =>
    validateStoredToken(rawToken, session.tokenHash, session.tokenSalt),
  );
}

export async function getPlatformSetupState() {
  const [config] = await db
    .select({ id: platformOauthConfigs.id })
    .from(platformOauthConfigs)
    .orderBy(desc(platformOauthConfigs.createdAt))
    .limit(1);

  return {
    hasSetupSession: await hasValidSetupSession(),
    platformAuthConfigured: Boolean(config),
  };
}

type SavePlatformSetupInput = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  adminEmail: string;
};

export async function savePlatformSetup(input: SavePlatformSetupInput) {
  const hasSetupSession = await hasValidSetupSession();
  if (!hasSetupSession) {
    throw new Error("Setup session expired. Exchange the bootstrap token again.");
  }

  const issuer = resolveOidcIssuerForServer(input.issuer);
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  const adminEmail = normalizeEmail(input.adminEmail);

  if (!issuer || !clientId || !clientSecret || !adminEmail) {
    throw new Error("All platform OIDC fields are required.");
  }

  await validateOidcIssuer(issuer);

  const encryptedSecret = encrypt(clientSecret);
  const [existingConfig] = await db
    .select({ id: platformOauthConfigs.id })
    .from(platformOauthConfigs)
    .orderBy(desc(platformOauthConfigs.createdAt))
    .limit(1);

  if (existingConfig) {
    await db
      .update(platformOauthConfigs)
      .set({
        issuer,
        clientId,
        clientSecretEncrypted: encryptedSecret,
      })
      .where(eq(platformOauthConfigs.id, existingConfig.id));
  } else {
    await db.insert(platformOauthConfigs).values({
      issuer,
      clientId,
      clientSecretEncrypted: encryptedSecret,
    });
  }

  const [existingAdmin] = await db
    .select({ id: platformAdmins.id })
    .from(platformAdmins)
    .where(eq(platformAdmins.email, adminEmail))
    .limit(1);

  if (!existingAdmin) {
    await db.insert(platformAdmins).values({
      email: adminEmail,
    });
  }
}

export async function finalizePlatformInitialization() {
  const now = new Date();
  const [installation] = await db
    .select()
    .from(platformInstallations)
    .orderBy(desc(platformInstallations.createdAt))
    .limit(1);

  if (installation) {
    await db
      .update(platformInstallations)
      .set({
        initializedAt: installation.initializedAt ?? now,
        updatedAt: now,
      })
      .where(eq(platformInstallations.id, installation.id));
  } else {
    await db.insert(platformInstallations).values({
      initializedAt: now,
      updatedAt: now,
    });
  }

  await db.delete(platformSetupSessions);
}
