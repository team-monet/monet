"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  exchangeBootstrapToken,
  SETUP_SESSION_COOKIE_NAME,
} from "@/lib/bootstrap";

export async function exchangeBootstrapTokenAction(formData: FormData) {
  const token = formData.get("token");
  if (typeof token !== "string" || token.trim().length === 0) {
    redirect("/setup?error=Bootstrap%20token%20is%20required");
  }

  try {
    const result = await exchangeBootstrapToken(token);
    const cookieStore = await cookies();
    cookieStore.set(SETUP_SESSION_COOKIE_NAME, result.setupSessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
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

  redirect("/setup");
}
