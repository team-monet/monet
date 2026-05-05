"use client";

import { useEffect, useRef } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  buildSessionRecoveryGuardKey,
  clearActiveSessionRecoveryGuard,
  hasActiveSessionRecoveryGuard,
  isExcludedFromSessionRecovery,
  isRefreshAccessTokenError,
  normalizeInternalCallbackUrl,
  setActiveSessionRecoveryGuard,
  SESSION_RECOVERY_PATH,
} from "@/lib/session-errors";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SessionProvider, signOut, useSession } from "next-auth/react";

type ShellUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
  scope?: "tenant" | "platform";
  tenantSlug?: string;
};

function SessionRecoveryWatcher({
  serverSessionError,
  scopeHint,
  tenantSlug,
}: {
  serverSessionError?: string;
  scopeHint: "tenant" | "platform";
  tenantSlug?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const signOutStartedRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientSessionError = (session as any)?.error;
  const sessionScope =
    (session?.user as { scope?: "tenant" | "platform" } | undefined)?.scope;
  const effectiveScope = sessionScope === "platform" ? "platform" : scopeHint;

  useEffect(() => {
    if (status === "authenticated" && !isRefreshAccessTokenError(clientSessionError)) {
      clearActiveSessionRecoveryGuard(window.sessionStorage);
    }
  }, [clientSessionError, status]);

  useEffect(() => {
    const effectiveError =
      isRefreshAccessTokenError(clientSessionError) ||
      isRefreshAccessTokenError(serverSessionError);
    if (!effectiveError) {
      return;
    }

    if (isExcludedFromSessionRecovery(pathname)) {
      return;
    }

    const currentSearch = searchParams.toString();
    const currentPath = `${pathname}${currentSearch ? `?${currentSearch}` : ""}`;
    const callbackUrl = normalizeInternalCallbackUrl(currentPath, "/");
    const guardKey = buildSessionRecoveryGuardKey(effectiveScope, callbackUrl);
    const loginPath = effectiveScope === "platform" ? "/platform/login" : "/login";

    if (hasActiveSessionRecoveryGuard(window.sessionStorage, guardKey)) {
      if (signOutStartedRef.current) {
        return;
      }
      signOutStartedRef.current = true;
      void signOut({ callbackUrl: loginPath }).catch(() => {
        signOutStartedRef.current = false;
        router.replace(loginPath);
      });
      return;
    }

    setActiveSessionRecoveryGuard(window.sessionStorage, guardKey);

    const recoveryUrl = new URL(SESSION_RECOVERY_PATH, window.location.origin);
    recoveryUrl.searchParams.set("callbackUrl", callbackUrl);
    recoveryUrl.searchParams.set("scope", effectiveScope);
    if (effectiveScope === "tenant" && tenantSlug) {
      recoveryUrl.searchParams.set("tenant", tenantSlug);
    }
    router.replace(`${recoveryUrl.pathname}?${recoveryUrl.searchParams.toString()}`);
  }, [
    clientSessionError,
    effectiveScope,
    pathname,
    router,
    searchParams,
    serverSessionError,
    tenantSlug,
  ]);

  return null;
}

function shouldHideSidebar(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/setup" ||
    pathname.startsWith("/platform")
  );
}

export function AppShell({
  hasSession,
  user,
  sessionError,
  children,
}: {
  hasSession: boolean;
  user?: ShellUser;
  sessionError?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isTenantSession = user?.scope !== "platform";
  const showSidebar =
    hasSession && isTenantSession && !shouldHideSidebar(pathname);
  const scope = user?.scope === "platform" ? "platform" : "tenant";

  return (
    <SessionProvider refetchInterval={2 * 60} refetchOnWindowFocus={true}>
      <SessionRecoveryWatcher
        serverSessionError={sessionError}
        scopeHint={scope}
        tenantSlug={user?.tenantSlug ?? undefined}
      />
      <TooltipProvider>
        {showSidebar ? (
          <SidebarProvider>
            <AppSidebar user={user} />
            <SidebarInset>
              <header className="flex h-16 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
                <div className="flex items-center gap-2 px-4">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-2 h-4" />
                </div>
                <div className="ml-auto px-4">
                  <ThemeToggle />
                </div>
              </header>
              <main className="flex flex-1 flex-col gap-4 p-4 pt-0">
                {children}
              </main>
            </SidebarInset>
          </SidebarProvider>
        ) : (
          <div className="min-h-screen">
            <div className="fixed right-4 top-4 z-50">
              <ThemeToggle />
            </div>
            {children}
          </div>
        )}
      </TooltipProvider>
    </SessionProvider>
  );
}
