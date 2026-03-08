import { cookies } from "next/headers";

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
