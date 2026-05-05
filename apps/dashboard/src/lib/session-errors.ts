export const REFRESH_ACCESS_TOKEN_ERROR = "RefreshAccessTokenError";
export const SESSION_RECOVERY_PATH = "/auth/session-recovery";
export const SESSION_RECOVERY_GUARD_TTL_MS = 2 * 60 * 1000;
const SESSION_RECOVERY_STORAGE_PREFIX = "monet:session-recovery";
const SESSION_RECOVERY_ACTIVE_GUARD_KEY = `${SESSION_RECOVERY_STORAGE_PREFIX}:active`;

export const SESSION_EXPIRED_ERROR_MESSAGE =
  "Your session has expired. Please log in again.";

export function isRefreshAccessTokenError(value: unknown) {
  return value === REFRESH_ACCESS_TOKEN_ERROR;
}

export function isSessionExpiredError(error: unknown) {
  return (
    error instanceof Error && error.message === SESSION_EXPIRED_ERROR_MESSAGE
  );
}

export function isExcludedFromSessionRecovery(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/platform/login" ||
    pathname === "/setup" ||
    pathname === "/signout" ||
    pathname === SESSION_RECOVERY_PATH ||
    pathname.startsWith("/api/auth/")
  );
}

export function normalizeInternalCallbackUrl(
  value: string | null | undefined,
  fallback = "/",
) {
  if (!value) {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return fallback;
  }

  return trimmed;
}

type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type RecoveryScope = "tenant" | "platform";

export function buildSessionRecoveryGuardKey(
  scope: RecoveryScope,
  callbackUrl: string,
) {
  const safeCallback = normalizeInternalCallbackUrl(callbackUrl, "/");
  return `${SESSION_RECOVERY_STORAGE_PREFIX}:${scope}:${safeCallback}`;
}

export function hasActiveSessionRecoveryGuard(
  storage: RecoveryStorage,
  guardKey: string,
  nowMs = Date.now(),
) {
  const raw = storage.getItem(guardKey);
  if (!raw) {
    return false;
  }

  try {
    const parsed = JSON.parse(raw) as { expiresAtMs?: number };
    if (typeof parsed.expiresAtMs !== "number" || parsed.expiresAtMs <= nowMs) {
      storage.removeItem(guardKey);
      return false;
    }

    return true;
  } catch {
    storage.removeItem(guardKey);
    return false;
  }
}

export function setActiveSessionRecoveryGuard(
  storage: RecoveryStorage,
  guardKey: string,
  nowMs = Date.now(),
  ttlMs = SESSION_RECOVERY_GUARD_TTL_MS,
) {
  storage.setItem(
    guardKey,
    JSON.stringify({
      expiresAtMs: nowMs + ttlMs,
    }),
  );
  storage.setItem(SESSION_RECOVERY_ACTIVE_GUARD_KEY, guardKey);
}

export function clearActiveSessionRecoveryGuard(storage: RecoveryStorage) {
  const guardKey = storage.getItem(SESSION_RECOVERY_ACTIVE_GUARD_KEY);
  if (guardKey) {
    storage.removeItem(guardKey);
  }
  storage.removeItem(SESSION_RECOVERY_ACTIVE_GUARD_KEY);
}
