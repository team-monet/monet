"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  exchangeBootstrapToken,
  savePlatformSetup,
  SETUP_SESSION_COOKIE_NAME,
} from "@/lib/bootstrap";

function isSecureConnection(requestHeaders: Headers): boolean {
  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("https");
  }

  return process.env.NEXTAUTH_URL?.startsWith("https://") ?? false;
}

export async function exchangeBootstrapTokenAction(formData: FormData) {
  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) {
    redirect("/setup?error=Bootstrap%20token%20is%20required");
  }

  try {
    const result = await exchangeBootstrapToken(token);
    const cookieStore = await cookies();
    const requestHeaders = await headers();
    cookieStore.set(SETUP_SESSION_COOKIE_NAME, result.setupSessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureConnection(requestHeaders),
      expires: new Date(result.expiresAt),
      path: "/",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to exchange bootstrap token";
    redirect(`/setup?error=${encodeURIComponent(message)}`);
  }

  redirect("/setup?step=platform-auth");
}

export async function savePlatformSetupAction(formData: FormData) {
  const issuer = formData.get("issuer");
  const clientId = formData.get("clientId");
  const clientSecret = formData.get("clientSecret");
  const adminEmail = formData.get("adminEmail");

  if (
    typeof issuer !== "string" ||
    typeof clientId !== "string" ||
    typeof clientSecret !== "string" ||
    typeof adminEmail !== "string"
  ) {
    redirect("/setup?error=All%20platform%20OIDC%20fields%20are%20required");
  }

  try {
    await savePlatformSetup({
      issuer,
      clientId,
      clientSecret,
      adminEmail,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save platform setup";
    redirect(`/setup?error=${encodeURIComponent(message)}`);
  }

  redirect("/platform/login");
}
