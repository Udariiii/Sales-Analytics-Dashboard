import Link from "next/link";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/components/auth-shell";

export default function SignupPage() {
  return <AuthShell title="Create your account" subtitle="Start a secure workspace for your sales analysis." footer={<>Already have an account? <Link href="/login">Sign in</Link></>}><AuthForm mode="signup" /></AuthShell>;
}
