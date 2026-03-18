export const REFRESH_ACCESS_TOKEN_ERROR = "RefreshAccessTokenError";

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
