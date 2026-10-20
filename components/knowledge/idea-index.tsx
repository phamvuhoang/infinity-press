import { ideaLinkItems, KnowledgeLinkList } from "@/components/knowledge/knowledge-link-list";
import type { Locale } from "@/lib/i18n/config";
import type { KnowledgeIdeaIndexGroup } from "@/lib/knowledge/public-types";

// The idea index body: one section per topic, in the order getIdeaIndex returns them, with the
// topic-less Other group (topic: null) labelled in this locale. An idea sits under each of its
// topics, but never twice in one group.
export function IdeaIndex({
  groups,
  locale,
  copy,
}: {
  groups: KnowledgeIdeaIndexGroup[];
  locale: Locale;
  copy: { empty: string; otherTopic: string };
}) {
  const visible = groups.filter((group) => group.ideas.length > 0);
  if (visible.length === 0) return <p className="text-[0.9375rem] text-ink-soft">{copy.empty}</p>;

  return (
    <div className="space-y-14">
      {visible.map((group) => {
        const key = group.topic ? `topic-${group.topic.slug}` : "other";
        const headingId = `ideas-${key}`;
        const ideas = group.ideas.filter(
          (idea, index) => group.ideas.findIndex((candidate) => candidate.ideaId === idea.ideaId) === index,
        );
        return (
          <section aria-labelledby={headingId} key={key}>
            <h2 className="mb-4 font-serif text-2xl font-normal" id={headingId}>
              {group.topic ? group.topic.name : copy.otherTopic}
            </h2>
            <KnowledgeLinkList items={ideaLinkItems(ideas)} locale={locale} />
          </section>
        );
      })}
    </div>
  );
}
