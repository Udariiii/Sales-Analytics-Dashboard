"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    if (!isSupabaseConfigured) {
      setError("Authentication is not configured yet.");
      setLoading(false);
      return;
    }
    const { error: resetError } = await createClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (resetError) setError(resetError.message);
    else setMessage("If an account exists for that email, a password reset link has been sent.");
    setLoading(false);
  };

  return <AuthShell title="Reset your password" subtitle="Enter your account email and we’ll send a secure reset link." footer={<Link href="/login">Back to sign in</Link>}>
    <form className="auth-form" onSubmit={submit}>
      <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
      {error && <div className="auth-message error" role="alert">{error}</div>}
      {message && <div className="auth-message success" role="status">{message}</div>}
      <button className="auth-submit" disabled={loading || !isSupabaseConfigured}>{loading ? "Sending…" : "Send reset link"}</button>
    </form>
  </AuthShell>;
}
