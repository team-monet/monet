type RefreshableToken = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  error?: string;
};

type RefreshedTokens = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
};

export function buildRefreshedToken<T extends RefreshableToken>(
  token: T,
  refreshedTokens: RefreshedTokens,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const nextToken = {
    ...token,
    accessToken: refreshedTokens.access_token,
    expiresAt: nowSeconds + (refreshedTokens.expires_in ?? 3600),
    refreshToken: refreshedTokens.refresh_token ?? token.refreshToken,
  } as T;

  delete nextToken.error;

  return nextToken;
}
