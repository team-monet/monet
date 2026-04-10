"use client";

import { useEffect } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { usePathname } from "next/navigation";
import { signOut, SessionProvider, useSession } from "next-auth/react";

type ShellUser = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
  scope?: "tenant" | "platform";
};

function shouldHideSidebar(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/setup" ||
    pathname.startsWith("/platform")
  );
}

function SessionWatcher() {
  const { data: session } = useSession();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionError = (session as any)?.error;

  useEffect(() => {
    if (sessionError === "RefreshAccessTokenError") {
      signOut({ callbackUrl: "/login" });
    }
  }, [sessionError]);

  return null;
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

  useEffect(() => {
    if (sessionError === "RefreshAccessTokenError") {
      signOut({ callbackUrl: "/login" });
    }
  }, [sessionError]);

  return (
    <SessionProvider refetchInterval={2 * 60} refetchOnWindowFocus={true}>
      <SessionWatcher />
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
