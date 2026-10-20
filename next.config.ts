import type { NextConfig } from "next";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  experimental: {
    // Enables `forbidden()` so admin-only server code can deny non-admins
    // with a real 403 instead of a manual redirect. See lib/auth/admin.ts.
    authInterrupts: true,
  },
  images: {
    // Only the public covers bucket. EPUB buckets are private and never go through next/image.
    remotePatterns: supabaseUrl ? [new URL(`${supabaseUrl}/storage/v1/object/public/covers/**`)] : [],
  },
};

export default nextConfig;
