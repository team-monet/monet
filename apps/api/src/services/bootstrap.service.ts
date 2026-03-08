import { randomBytes } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  type InferSelectModel,
} from "drizzle-orm";
import type { Database } from "@monet/db";
import {
  platformBootstrapTokens,
  platformInstallations,
  platformSetupSessions,
} from "@monet/db";
import { hashApiKey, validateApiKey } from "./api-key.service.js";

const BOOTSTRAP_TOKEN_PREFIX = "mbt_";
const SETUP_SESSION_PREFIX = "mss_";
const BOOTSTRAP_TOKEN_TTL_MS = 30 * 60 * 1000;
const SETUP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
type BootstrapErrorStatus = 400 | 401 | 409;

type PlatformInstallationRow = InferSelectModel<typeof platformInstallations>;
type PlatformBootstrapTokenRow = InferSelectModel<typeof platformBootstrapTokens>;
type PlatformSetupSessionRow = InferSelectModel<typeof platformSetupSessions>;

export class BootstrapTokenError extends Error {
  status: BootstrapErrorStatus;

  constructor(message: string, status: BootstrapErrorStatus = 400) {
    super(message);
    this.name = "BootstrapTokenError";
    this.status = status;
  }
}

function generateToken(prefix: string) {
  return `${prefix}${randomBytes(24).toString("base64url")}`;
}

async function getLatestInstallation(
  db: Database,
): Promise<PlatformInstallationRow | null> {
  const [installation] = await db
    .select()
    .from(platformInstallations)
    .orderBy(desc(platformInstallations.createdAt))
    .limit(1);

  return installation ?? null;
}

async function ensureInstallationRow(
  db: Database,
): Promise<PlatformInstallationRow> {
  const existing = await getLatestInstallation(db);
  if (existing) return existing;

  const [installation] = await db
    .insert(platformInstallations)
    .values({})
    .returning();

  return installation;
}

async function listActiveBootstrapTokens(
  db: Database,
  now: Date,
): Promise<PlatformBootstrapTokenRow[]> {
  return db
    .select()
    .from(platformBootstrapTokens)
    .where(
      and(
        isNull(platformBootstrapTokens.usedAt),
        gt(platformBootstrapTokens.expiresAt, now),
      ),
    )
    .orderBy(desc(platformBootstrapTokens.createdAt));
}

async function invalidateActiveBootstrapTokens(db: Database, now: Date) {
  await db
    .update(platformBootstrapTokens)
    .set({ expiresAt: now })
    .where(
      and(
        isNull(platformBootstrapTokens.usedAt),
        gt(platformBootstrapTokens.expiresAt, now),
      ),
    );
}

export async function getBootstrapStatus(db: Database) {
  const installation = await getLatestInstallation(db);
  const initialized = Boolean(installation?.initializedAt);

  return {
    initialized,
    setupRequired: !initialized,
  };
}

export async function ensureBootstrapToken(db: Database) {
  const status = await getBootstrapStatus(db);
  if (status.initialized) {
    return null;
  }

  await ensureInstallationRow(db);

  const now = new Date();
  await invalidateActiveBootstrapTokens(db, now);

  const rawToken = generateToken(BOOTSTRAP_TOKEN_PREFIX);
  const { hash, salt } = hashApiKey(rawToken);
  const expiresAt = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS);

  await db.insert(platformBootstrapTokens).values({
    tokenHash: hash,
    tokenSalt: salt,
    expiresAt,
  });

  return {
    rawToken,
    expiresAt,
  };
}

export async function exchangeBootstrapToken(db: Database, rawToken: string) {
  const trimmedToken = rawToken.trim();
  if (!trimmedToken) {
    throw new BootstrapTokenError("Bootstrap token is required", 400);
  }

  const status = await getBootstrapStatus(db);
  if (status.initialized) {
    throw new BootstrapTokenError("Platform setup is already complete", 409);
  }

  const now = new Date();
  const activeTokens = await listActiveBootstrapTokens(db, now);
  const matchedToken = activeTokens.find((token) =>
    validateApiKey(trimmedToken, token.tokenHash, token.tokenSalt),
  );

  if (!matchedToken) {
    throw new BootstrapTokenError("Invalid or expired bootstrap token", 401);
  }

  await db
    .update(platformBootstrapTokens)
    .set({ usedAt: now })
    .where(eq(platformBootstrapTokens.id, matchedToken.id));

  const sessionToken = generateToken(SETUP_SESSION_PREFIX);
  const { hash, salt } = hashApiKey(sessionToken);
  const expiresAt = new Date(now.getTime() + SETUP_SESSION_TTL_MS);

  await db.insert(platformSetupSessions).values({
    tokenHash: hash,
    tokenSalt: salt,
    expiresAt,
  });

  return {
    sessionToken,
    expiresAt,
  };
}

export async function validateSetupSession(
  db: Database,
  rawToken: string,
) {
  const trimmedToken = rawToken.trim();
  if (!trimmedToken) return false;

  const now = new Date();
  const sessions: PlatformSetupSessionRow[] = await db
    .select()
    .from(platformSetupSessions)
    .where(gt(platformSetupSessions.expiresAt, now))
    .orderBy(desc(platformSetupSessions.createdAt));

  return sessions.some((session) =>
    validateApiKey(trimmedToken, session.tokenHash, session.tokenSalt),
  );
}
