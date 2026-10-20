"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readText, type AdminFormState } from "@/lib/catalog/form";
import { createBundleSchema } from "@/lib/catalog/schemas";
import { createBundle, DuplicateBundleSlugError } from "@/lib/data/bundles";

// Every runtime export of a "use server" module must be an async function, so the form's initial
// state comes from lib/catalog/form.ts rather than from here.

const genericFailure = "Something went wrong saving. Try again.";

// Creating a bundle is creating its first localization: a bundle has no canonical key and no
// unlocalized name. Everything else - members, price, cover, publication - is set in the editor.
export async function createBundleAction(_previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/bundles/new" });

  const parsed = createBundleSchema.safeParse({
    locale: readText(formData, "locale"),
    slug: readText(formData, "slug"),
    title: readText(formData, "title"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  let bundleId: string;
  try {
    ({ bundleId } = await createBundle(parsed.data));
  } catch (error) {
    // A taken slug is a named condition the operator can fix by retyping, not a generic failure.
    if (error instanceof DuplicateBundleSlugError) {
      return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath("/admin/bundles");
  redirect(`/admin/bundles/${bundleId}`);
}
