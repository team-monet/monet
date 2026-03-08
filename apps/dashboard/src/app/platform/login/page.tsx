import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getBootstrapStatus, getPlatformSetupState } from "@/lib/bootstrap";
import PlatformLoginForm from "./platform-login-form";

export default async function PlatformLoginPage() {
  const session = await auth();
  const scope = (session?.user as { scope?: "tenant" | "platform" } | undefined)
    ?.scope;

  if (scope === "platform") {
    redirect("/platform");
  }

  const bootstrapStatus = await getBootstrapStatus();
  const setupState = await getPlatformSetupState();

  if (!setupState.platformAuthConfigured) {
    redirect(bootstrapStatus.initialized ? "/login" : "/setup");
  }

  return <PlatformLoginForm />;
}
