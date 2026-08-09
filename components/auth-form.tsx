"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export function AuthForm({ mode, configurationMissing = false }: { mode: "login" | "signup"; configurationMissing?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const configured = isSupabaseConfigured && !configurationMissing;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!configured) {
      setError("Authentication is awaiting its Supabase environment configuration.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    if (mode === "login") {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) setError(signInError.message);
      else {
        router.push("/");
        router.refresh();
      }
    } else {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name.trim() },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (signUpError) setError(signUpError.message);
      else if (data.session) {
        router.push("/");
        router.refresh();
      } else setMessage("Check your email to confirm your account, then return here to sign in.");
    }
    setLoading(false);
  };

  const signInWithGoogle = async () => {
    setError("");
    if (!configured) {
      setError("Authentication is awaiting its Supabase environment configuration.");
      return;
    }
    setLoading(true);
    const { error: googleError } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (googleError) {
      setError(googleError.message);
      setLoading(false);
    }
  };

  return (
    <>
      {!configured && <div className="auth-config-note"><strong>Setup required</strong><span>Add the Supabase URL and publishable key in Vercel before accepting sign-ins.</span></div>}
      <button className="google-button" type="button" onClick={signInWithGoogle} disabled={loading || !configured}>
        <span aria-hidden="true">G</span>{mode === "login" ? "Continue with Google" : "Sign up with Google"}
      </button>
      <div className="auth-divider"><span>or continue with email</span></div>
      <form className="auth-form" onSubmit={submit}>
        {mode === "signup" && <label>Full name<input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label>}
        <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
        <label>
          <span>Password{mode === "login" && <Link href="/forgot-password">Forgot password?</Link>}</span>
          <input required minLength={8} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" />
        </label>
        {mode === "signup" && <label>Confirm password<input required minLength={8} type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat your password" /></label>}
        {error && <div className="auth-message error" role="alert">{error}</div>}
        {message && <div className="auth-message success" role="status">{message}</div>}
        <button className="auth-submit" disabled={loading || !configured}>{loading ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
      </form>
    </>
  );
}
