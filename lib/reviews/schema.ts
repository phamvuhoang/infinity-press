import { z } from "zod";

// Reviews and author replies are plain text. A tag-shaped run is rejected, but a bare "<" or ">"
// (for example "3 < 5") is fine. Rendering still escapes everything.
export const NO_HTML = /<\/?[a-z][^>]*>/i;

export function plainText(min: number, max: number, label: string) {
  return z
    .string()
    .trim()
    .min(min, { error: `Enter ${label}.` })
    .max(max, { error: `Keep ${label} under ${max} characters.` })
    .refine((text) => !NO_HTML.test(text), { error: "HTML is not allowed." });
}

export const reviewInputSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  body: plainText(1, 1000, "your review"),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;
