import type { Locale } from "@/lib/i18n/config";
import { absoluteUrl } from "@/lib/seo/metadata";

// price is a ready-to-print book price (S19): what a buyer pays now, with the list price during a sale.
export type LlmsEntry = { title: string; path: string; description: string | null; price?: string | null };
export type LlmsLocaleSection = {
  locale: Locale;
  heading: string;
  intro: string;
  groups: { heading: string; entries: LlmsEntry[] }[];
};

const MAX_DESCRIPTION = 200;

// One line per entity: every whitespace run (newlines included) becomes a single space, and a long
// text is cut at a word boundary and ends in one "…".
export function truncateDescription(text: string | null, max = MAX_DESCRIPTION): string | null {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const boundary = flat[max] === " " ? max : cut.lastIndexOf(" ");
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

// null when the title is empty after cleaning: a `- [](url)` line would be a link with no name.
function line(siteUrl: string, entry: LlmsEntry): string | null {
  const title = entry.title.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const description = truncateDescription(entry.description);
  const price = entry.price ? ` (${entry.price})` : "";
  return `- [${title}](${absoluteUrl(siteUrl, entry.path)})${price}${description ? `: ${description}` : ""}`;
}

// llms.txt Markdown: the first locale section is the document (`#`), later ones nest below it.
export function buildLlmsText({ siteUrl, sections }: { siteUrl: string; sections: LlmsLocaleSection[] }): string {
  const out: string[] = [];
  sections.forEach((section, index) => {
    const h = index === 0 ? "#" : "##";
    const g = index === 0 ? "##" : "###";
    out.push(`${h} ${section.heading}`, "", `> ${truncateDescription(section.intro, Infinity) ?? ""}`, "");
    for (const group of section.groups) {
      const lines = group.entries.flatMap((entry) => line(siteUrl, entry) ?? []);
      if (lines.length === 0) continue;
      out.push(`${g} ${group.heading}`, ...lines, "");
    }
  });
  return out.join("\n");
}
