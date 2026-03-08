import { redirect } from "next/navigation";
import { getBootstrapStatus } from "@/lib/bootstrap";
import LoginForm from "./login-form";

export default async function LoginPage() {
  const status = await getBootstrapStatus();
  if (status.setupRequired) {
    redirect("/setup");
  }

  return <LoginForm />;
}
