"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  exchangeBootstrapToken,
  savePlatformSetup,
  SETUP_SESSION_COOKIE_NAME,
} from "@/lib/bootstrap";
import type { SetupActionState } from "./actions-shared";

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

export async function exchangeBootstrapTokenAction(
  formData: FormData,
): Promise<SetupActionState> {
  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) {
    return {
      status: "error",
      message: "Bootstrap token is required.",
    };
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
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Failed to exchange bootstrap token",
    };
  }

  revalidatePath("/setup");
  return {
    status: "success",
    message: "Bootstrap token accepted. Continue with platform configuration.",
  };
}

export async function savePlatformSetupAction(
  formData: FormData,
): Promise<SetupActionState> {
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
    return {
      status: "error",
      message: "All platform OIDC fields are required.",
    };
  }

  try {
    await savePlatformSetup({
      issuer,
      clientId,
      clientSecret,
      adminEmail,
    });
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error ? error.message : "Failed to save platform setup",
    };
  }

  revalidatePath("/setup");
  return {
    status: "success",
    message: "Platform OIDC configured. Continue to platform login.",
  };
}
