"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readList, type AdminFormState } from "@/lib/catalog/form";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { merchandisingSchema } from "@/lib/catalog/schemas";
import { setMerchandising } from "@/lib/data/merchandising";

const genericFailure = "Something went wrong saving. Try again.";

export async function saveMerchandisingAction(
  slotKey: "home_featured" | "home_shelf",
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/merchandising" });

  const parsed = merchandisingSchema.safeParse({ slotKey, bookIds: readList(formData, "bookIds") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await setMerchandising(parsed.data);
  } catch {
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath("/admin/merchandising");
  revalidateStorefront();
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
