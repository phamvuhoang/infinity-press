import { createServiceRoleClient } from "./supabase";

// Specs that build a one-language work need its single edition: grants, uploads and the reader are
// all per edition. A work with several editions must name one explicitly, so this refuses to guess.
export async function soleEditionId(bookId: string): Promise<string> {
  const { data, error } = await createServiceRoleClient().from("editions").select("id").eq("book_id", bookId);
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`expected exactly one edition for book ${bookId}, found ${data?.length ?? 0}`);
  return data[0].id;
}
