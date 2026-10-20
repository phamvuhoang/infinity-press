import { createClient } from "@supabase/supabase-js";

// Fixtures built on this client create confirmed auth users and grant them the
// admin role, with no teardown. There is exactly one hosted Supabase project
// and no staging tier, so a mistyped NEXT_PUBLIC_SUPABASE_URL would mint real
// admin accounts in production. Refuse anything that is not loopback before
// the service-role key is ever used.
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must point to the local Supabase stack`);
  return value;
}

function requireLoopbackUrl(name: string) {
  const value = requireEnv(name);

  let hostname: string;
  try {
    ({ hostname } = new URL(value));
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }

  if (!loopbackHosts.has(hostname)) {
    throw new Error(
      `Refusing to run E2E fixtures against "${hostname}". ${name} must point at a loopback ` +
        `Supabase stack (${[...loopbackHosts].join(", ")}); these fixtures create confirmed ` +
        `users and grant the admin role through the service-role key, and nothing cleans them up.`,
    );
  }

  return value;
}

export function createServiceRoleClient() {
  return createClient(
    requireLoopbackUrl("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// An UNPRIVILEGED client, holding the same publishable key a browser gets. Two things need it,
// and neither can use the service-role client above:
//
//  - Anonymous visibility assertions. service_role bypasses RLS entirely, so a check made with it
//    proves a row exists, never that the public may see it. Ruling CB's concern - that nothing
//    set books.status and nothing set authors.status - is invisible to a service-role read by
//    construction, which is part of why it survived every review.
//  - Acting as a signed-in user (sign in, then call an RPC). Every customer- and admin-facing RPC
//    in this schema resolves the caller through auth.uid(), which is null under service_role
//    (Ruling W's trap), so those calls can only be made through this client.
export function createAnonClient() {
  return createClient(
    requireLoopbackUrl("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
