export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

export function requireSupabaseConfig() {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("Authentication is not configured yet. Add the Supabase environment variables in Vercel.");
  }

  return { supabaseUrl, supabasePublishableKey };
}
