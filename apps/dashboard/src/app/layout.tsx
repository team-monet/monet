import "./globals.css";
import { auth } from "@/lib/auth";
import { User } from "next-auth";
import Script from "next/script";
import { AppShell } from "@/components/app-shell";

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
        <Script id="timezone-init" strategy="beforeInteractive">
          {`
            try {
              var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              if (tz) {
                var secure = location.protocol === "https:" ? "; Secure" : "";
                document.cookie = "x-timezone=" + encodeURIComponent(tz) + "; path=/; max-age=31536000; SameSite=Lax" + secure;
              }
            } catch (_) {}
          `}
        </Script>
        <AppShell hasSession={Boolean(session)} user={user}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
