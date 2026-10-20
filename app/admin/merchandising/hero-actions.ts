"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { heroAltTextSchema, heroUploadSchema } from "@/lib/catalog/schemas";
import { clearHomeHero, createHeroUpload, setHomeHero } from "@/lib/data/home-hero";

export type HeroActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const generic = "Something went wrong saving the hero image. Try again.";
const next = "/admin/merchandising";

export async function createHeroUploadAction(input: {
  variant: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<HeroActionResult<{ storageKey: string; path: string; token: string }>> {
  await requireAdmin({ next });

  const parsed = heroUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a hero image." };

  try {
    return { ok: true, ...(await createHeroUpload(parsed.data)) };
  } catch {
    return { ok: false, error: generic };
  }
}

export async function saveHeroAction(input: {
  desktopKey: string;
  mobileKey: string;
  altText: string;
}): Promise<HeroActionResult<object>> {
  await requireAdmin({ next });

  const altText = heroAltTextSchema.safeParse(input.altText);
  if (!altText.success) return { ok: false, error: altText.error.issues[0]?.message ?? "Describe the hero image." };

  try {
    await setHomeHero({ desktopKey: input.desktopKey, mobileKey: input.mobileKey, altText: altText.data });
  } catch {
    return { ok: false, error: generic };
  }

  revalidatePath(next);
  revalidateStorefront();
  return { ok: true };
}

export async function clearHeroAction(): Promise<HeroActionResult<object>> {
  await requireAdmin({ next });

  try {
    await clearHomeHero();
  } catch {
    return { ok: false, error: generic };
  }

  revalidatePath(next);
  revalidateStorefront();
  return { ok: true };
}
