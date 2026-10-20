import type { BookEditorSection } from "@/lib/catalog/readiness";

export type EditorSectionLink = { id: BookEditorSection; label: string };

export function SectionNav({ sections }: { sections: EditorSectionLink[] }) {
  return (
    <nav aria-label="Book editor sections" className="mb-10 flex flex-wrap gap-x-5 gap-y-1 border-b border-sand pb-3 text-sm">
      {sections.map((section) => (
        <a className="inline-flex min-h-11 items-center text-forest hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" href={`#${section.id}`} key={section.id}>
          {section.label}
        </a>
      ))}
    </nav>
  );
}
