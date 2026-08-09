import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ configuration?: string }> }) {
  const params = await searchParams;
  return <AuthShell title="Sign in to your workspace" subtitle="Access your private sales analysis dashboard." footer={<>New to RetailPulse? <Link href="/signup">Create an account</Link></>}><AuthForm mode="login" configurationMissing={params.configuration === "missing"} /></AuthShell>;
}
