import "server-only";
import { cache } from "react";

import { getSessionUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/database.types";

export type ProfileDTO = Pick<Tables<"profiles">, "id" | "auth_user_id" | "display_name" | "locale">;

// The current user's own profile, or null when signed out or the row cannot
// be read. Selects only the columns callers may safely render; no auth
// metadata, timestamps, or role data leaves this function.
export const getCurrentProfile = cache(async (): Promise<ProfileDTO | null> => {
  const user = await getSessionUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, auth_user_id, display_name, locale")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error || !data) return null;

  return data;
});
