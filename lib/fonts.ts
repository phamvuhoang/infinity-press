import { Be_Vietnam_Pro, Lora } from "next/font/google";

// Lora carries headings and reading text; Be Vietnam Pro carries UI. Both ship the Vietnamese
// subset so diacritics render from the same face rather than a fallback. They live here rather
// than in a layout because the app has one root layout per top-level area and they all share
// these two faces.
//
// Every weight and style listed here is preloaded in <head> for each subset, on every page, so the
// list is kept to what the UI renders: no Lora italic (<em> falls back to a synthesized oblique)
// and no Be Vietnam Pro 600 (<strong> renders at 500). On a slow 4G connection these preloads
// compete with the hero image, which is the LCP element on the home page.
export const lora = Lora({
  subsets: ["latin", "vietnamese"],
  variable: "--font-lora",
});

export const beVietnamPro = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500"],
  variable: "--font-be-vietnam-pro",
});
