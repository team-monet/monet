import "./globals.css";
import { auth } from "@/lib/auth";
import { User } from "next-auth";
import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import Script from "next/script";
import { ThemeToggle } from "@/components/theme-toggle";

interface ExtendedUser extends User {
  role?: string;
  tenantId?: string;
  scope?: "tenant" | "platform";
}

export const metadata = {
  title: "Monet",
  description: "Browse and manage AI agent memories",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const user = session?.user as ExtendedUser | undefined;
  const isTenantSession = user?.scope !== "platform";

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Script id="theme-init" strategy="beforeInteractive">
          {`
            try {
              var savedTheme = localStorage.getItem("theme");
              var isDark = savedTheme === "dark" || (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches);
              document.documentElement.classList.toggle("dark", isDark);
              document.documentElement.style.colorScheme = isDark ? "dark" : "light";
            } catch (_) {}
          `}
        </Script>
        <TooltipProvider>
          {session && isTenantSession ? (
            <SidebarProvider>
              <AppSidebar user={user} />
              <SidebarInset>
                <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12 border-b">
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
      </body>
    </html>
  );
}
