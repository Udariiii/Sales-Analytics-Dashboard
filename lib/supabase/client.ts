import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseConfig } from "./config";

export function createClient() {
  const { supabaseUrl, supabasePublishableKey } = requireSupabaseConfig();
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}
