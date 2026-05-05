"use client";

import { useEffect, useRef } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  buildSessionRecoveryGuardKey,
  hasActiveSessionRecoveryGuard,
  normalizeInternalCallbackUrl,
} from "@/lib/session-errors";

const TENANT_LOGIN_PATH = "/login";
const PLATFORM_LOGIN_PATH = "/platform/login";

function resolveScope(
  scopeParam: string | null,
  sessionScope: "tenant" | "platform" | undefined,
) {
  if (scopeParam === "tenant" || scopeParam === "platform") {
    return scopeParam;
  }

  if (sessionScope === "tenant" || sessionScope === "platform") {
    return sessionScope;
  }

  return "tenant";
}

export default function SessionRecoveryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const signInStartedRef = useRef(false);

  useEffect(() => {
    const callbackUrl = normalizeInternalCallbackUrl(
      searchParams.get("callbackUrl"),
      "/",
    );
    const sessionScope =
      (session?.user as { scope?: "tenant" | "platform" } | undefined)?.scope;
    const scope = resolveScope(searchParams.get("scope"), sessionScope);
    const fallbackPath = scope === "platform" ? PLATFORM_LOGIN_PATH : TENANT_LOGIN_PATH;
    const tenantSlug =
      searchParams.get("tenant") ||
      (session?.user as { tenantSlug?: string } | undefined)?.tenantSlug;

    if (status === "loading") {
      return;
    }

    const guardKey = buildSessionRecoveryGuardKey(scope, callbackUrl);
    if (!hasActiveSessionRecoveryGuard(window.sessionStorage, guardKey)) {
      router.replace(fallbackPath);
      return;
    }

    if (scope === "tenant") {
      if (!tenantSlug) {
        router.replace(TENANT_LOGIN_PATH);
        return;
      }

      document.cookie = `tenant-slug=${encodeURIComponent(tenantSlug)}; path=/; max-age=3600; SameSite=Lax`;
    }

    const provider = scope === "platform" ? "platform-oauth" : "tenant-oauth";

    if (signInStartedRef.current) {
      return;
    }
    signInStartedRef.current = true;

    void signIn(provider, { callbackUrl }).catch(() => {
      signInStartedRef.current = false;
      router.replace(fallbackPath);
    });
  }, [router, searchParams, session, status]);

  return null;
}
