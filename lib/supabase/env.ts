import { isSecureOrLoopbackUrl } from "@/lib/config/url";

type PublicEnvironment = Record<string, string | undefined>;

export function getSupabaseEnv(values: PublicEnvironment) {
  const url = values.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey || !isSecureOrLoopbackUrl(url)) {
    throw new Error("Supabase environment variables are missing or invalid");
  }

  return { url, publishableKey };
}
