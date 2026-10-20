import type { SupabaseClient } from "@supabase/supabase-js";

import { createAnonClient, createServiceRoleClient } from "./supabase";

// S12 knowledge fixtures. Local stack only: both clients come from ./supabase, which refuses any
// non-loopback NEXT_PUBLIC_SUPABASE_URL before a key is used.
//
// Every idea write goes through the real admin RPCs as a SIGNED-IN admin. is_admin() resolves the
// caller through auth.uid(), which is null under service_role, so the service-role client can only
// create the admin user and read back audit rows - it never calls an admin-only RPC. That also
// means these fixtures exercise the same readiness gate, audit rows, and constraints the editor
// does. Like every other fixture here, nothing is torn down.

type Locale = "vi" | "en";

function check<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as NonNullable<T>;
}

export type KnowledgeAdmin = { email: string; password: string; profileId: string };

// A confirmed user with a password (the /internal sign-in form and signInWithPassword both need
// one) and the admin role.
export async function createKnowledgeAdmin(prefix = "knowledge-admin"): Promise<KnowledgeAdmin> {
  const service = createServiceRoleClient();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "knowledge-admin-password-1";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const profile = check(await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single());
  check(await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" }));
  return { email, password, profileId: profile.id as string };
}

// An authenticated client holding only the publishable key and the admin's own session.
export async function signInKnowledgeAdmin(admin: KnowledgeAdmin): Promise<SupabaseClient> {
  const client = createAnonClient();
  const { error } = await client.auth.signInWithPassword({ email: admin.email, password: admin.password });
  if (error) throw error;
  return client;
}

// The smallest valid typed body: one plain paragraph (lib/knowledge/blocks.ts).
export function paragraphBlock(text: string) {
  return { type: "paragraph" as const, content: [{ text }] };
}

// Creates, localizes, relates, and publishes an idea in one locale through the admin RPCs. publish_idea
// enforces readiness (a complete localization, at least one block, a published related book), so a
// fixture that returns has produced an idea the storefront can show.
export async function seedPublishedIdea(
  client: SupabaseClient,
  options: {
    locale: Locale;
    slug: string;
    question: string;
    shortAnswer: string;
    body: string;
    bookIds: string[];
    topicIds?: string[];
    relatedIdeaIds?: string[];
  },
): Promise<{ ideaId: string }> {
  const ideaId = check(
    await client.rpc("admin_create_idea", {
      p_locale: options.locale,
      p_slug: options.slug,
      p_question: options.question,
      p_short_answer: options.shortAnswer,
    }),
  ) as string;
  check(
    await client.rpc("admin_save_idea_localization", {
      p_idea_id: ideaId,
      p_locale: options.locale,
      p_slug: options.slug,
      p_question: options.question,
      p_short_answer: options.shortAnswer,
      p_body_blocks: [paragraphBlock(options.body)],
    }),
  );
  check(
    await client.rpc("admin_set_idea_relations", {
      p_idea_id: ideaId,
      p_book_ids: options.bookIds,
      p_topic_ids: options.topicIds ?? [],
      p_related_idea_ids: options.relatedIdeaIds ?? [],
    }),
  );
  check(await client.rpc("publish_idea", { p_idea_id: ideaId }));
  return { ideaId };
}

// The audit trail for one knowledge entity, oldest first. Read with service role: audit_logs is not
// readable by API roles, and this is an assertion, not an admin action.
export async function knowledgeAuditActions(entityId: string): Promise<{ action: string; actorProfileId: string | null }[]> {
  const rows = check(
    await createServiceRoleClient()
      .from("audit_logs")
      .select("action,actor_profile_id,created_at")
      .eq("entity_id", entityId)
      .order("created_at"),
  ) as { action: string; actor_profile_id: string | null }[];
  return rows.map((row) => ({ action: row.action, actorProfileId: row.actor_profile_id }));
}

// What the database actually stored for one idea localization's body, as JSON text - the thing an
// "HTML never reaches storage" assertion has to look at.
export async function storedIdeaBody(ideaId: string, locale: Locale): Promise<string> {
  const row = check(
    await createServiceRoleClient()
      .from("idea_localizations")
      .select("body_blocks")
      .eq("idea_id", ideaId)
      .eq("locale", locale)
      .single(),
  ) as { body_blocks: unknown };
  return JSON.stringify(row.body_blocks);
}
