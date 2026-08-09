import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";

export default function AuthCodeErrorPage() {
  return <AuthShell title="We could not complete sign-in" subtitle="The link may have expired or the provider did not approve the request."><Link className="auth-submit auth-link-button" href="/login">Return to sign in</Link></AuthShell>;
}
