import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import type { MerchandisingInput } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/server";

export type MerchandisingDTO = { featuredBookId: string | null; shelfBookIds: string[] };

type SlotRow = { slot_key: "home_featured" | "home_shelf"; book_id: string; position: number };

function failure(operation: string): Error {
  return new Error(`${operation} failed.`);
}

export async function getMerchandising(): Promise<MerchandisingDTO> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.from("merchandising_slots").select("slot_key, book_id, position").order("position");
  if (error) throw failure("getMerchandising");

  const rows = ((data ?? []) as SlotRow[]).slice().sort((left, right) => left.position - right.position);
  return {
    featuredBookId: rows.find((row) => row.slot_key === "home_featured")?.book_id ?? null,
    shelfBookIds: rows.filter((row) => row.slot_key === "home_shelf").map((row) => row.book_id),
  };
}

export async function setMerchandising(input: MerchandisingInput): Promise<void> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_merchandising", { p_slot_key: input.slotKey, p_book_ids: input.bookIds });
  if (error) throw failure("setMerchandising");
}
