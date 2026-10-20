import { z } from "zod";

import { retailers, type Retailer } from "@/lib/analytics/browser";
import type { Locale } from "@/lib/i18n/config";

export { retailers, type Retailer };

const UTM = { utm_source: "infinitybookspress", utm_medium: "book_page", utm_campaign: "paperback" } as const;

// Appends the site's UTM set unless the stored URL already carries any utm_* key: an affiliate
// URL has its own tracking and must not be corrupted. Never throws - a bad stored URL is the
// admin RPC's problem, and the button must still render.
export function withRetailUtm(url: string, locale: Locale): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "https:") return url;
  for (const key of parsed.searchParams.keys()) if (key.startsWith("utm_")) return url;
  for (const [key, value] of Object.entries(UTM)) parsed.searchParams.set(key, value);
  parsed.searchParams.set("utm_content", locale);
  return parsed.toString();
}

export function retailerLabel(
  link: { retailer: Retailer; label: string | null },
  labels: Record<Exclude<Retailer, "other">, string>,
): string {
  return link.retailer === "other" ? (link.label ?? "") : labels[link.retailer];
}

export const retailLinkSchema = z
  .object({
    retailer: z.enum(retailers),
    label: z.string().trim().min(1).max(80).nullable(),
    url: z.url({ protocol: /^https$/, error: "Enter an absolute https:// URL." }),
    priceMinor: z.number().int().min(0).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    active: z.boolean(),
  })
  .refine((link) => (link.retailer === "other") === (link.label !== null), {
    message: "A label is required exactly when the retailer is Other.",
    path: ["label"],
  })
  .refine((link) => (link.priceMinor === null) === (link.currency === null), {
    message: "Price and currency go together.",
    path: ["priceMinor"],
  });

export const retailLinksSchema = z.object({ links: z.array(retailLinkSchema).max(10) });
export type RetailLinkInput = z.infer<typeof retailLinkSchema>;
