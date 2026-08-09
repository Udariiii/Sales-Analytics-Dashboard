"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/auth-shell";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (password.length < 8) return setError("Use at least 8 characters for your password.");
    if (password !== confirmPassword) return setError("The passwords do not match.");
    setLoading(true);
    const { error: updateError } = await createClient().auth.updateUser({ password });
    if (updateError) setError(updateError.message);
    else {
      router.push("/");
      router.refresh();
    }
    setLoading(false);
  };

  return <AuthShell title="Choose a new password" subtitle="Create a strong password you have not used elsewhere.">
    <form className="auth-form" onSubmit={submit}>
      <label>New password<input required minLength={8} type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>
      <label>Confirm new password<input required minLength={8} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat your password" /></label>
      {error && <div className="auth-message error" role="alert">{error}</div>}
      <button className="auth-submit" disabled={loading}>{loading ? "Updating…" : "Update password"}</button>
    </form>
  </AuthShell>;
}
