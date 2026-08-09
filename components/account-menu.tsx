"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function AccountMenu() {
  const router = useRouter();
  const [email, setEmail] = useState("");

  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? "Account"));
  }, []);

  const signOut = async () => {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return <div className="account-menu"><span title={email}>{email || "Account"}</span><button onClick={signOut}>Sign out</button></div>;
}
