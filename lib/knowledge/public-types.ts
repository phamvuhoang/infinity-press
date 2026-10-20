import type { CatalogBookCard, CatalogTopicRef } from "@/lib/catalog/public-types";
import type { KnowledgeBlock, KnowledgeIdeaReference } from "@/lib/knowledge/blocks";
import type { AlternateSlugs } from "@/lib/i18n/alternates";

// Shapes that public knowledge pages render. Everything here is published and localized in the
// requested locale; lib/data/knowledge.ts drops any reference that is not. Timestamps are ISO
// strings as Postgres serializes them.

export type KnowledgeTopicRef = CatalogTopicRef;

// slug is null when the author has no public page in this locale; the byline is then plain text.
export type KnowledgeAuthorRef = { name: string; slug: string | null };

// A published idea as the index, related-idea lists, and `idea_card` blocks show it. It satisfies
// KnowledgeIdeaReference, so it can go straight into BlockRenderer's `ideasById`.
export type KnowledgeIdeaSummary = KnowledgeIdeaReference & {
  createdAt: string;
  // The localization's last edit.
  updatedAt: string;
  alternateSlugs: AlternateSlugs;
  // The locale of the copy shown: the requested one, else the platform default metadata locale.
  metadataLocale: string;
  // Every published topic with a public page in this locale, ordered by name.
  topics: KnowledgeTopicRef[];
};

// One section of the idea index. `topic: null` is the Other / Khác group, always last; the page
// supplies the localized label. An idea appears under each of its topics once.
export type KnowledgeIdeaIndexGroup = {
  topic: KnowledgeTopicRef | null;
  ideas: KnowledgeIdeaSummary[];
};

export type KnowledgeArticleSummary = {
  articleId: string;
  slug: string;
  title: string;
  excerpt: string;
  // Set on the first publish and preserved across unpublish/republish.
  publishedAt: string;
  updatedAt: string;
  alternateSlugs: AlternateSlugs;
  metadataLocale: string;
  author: KnowledgeAuthorRef;
};

type KnowledgeRenderContext = {
  blocks: KnowledgeBlock[];
  // Exactly what BlockRenderer takes: every visible book and idea the blocks or relations name.
  // A block whose reference is missing here is omitted by the renderer.
  booksById: ReadonlyMap<string, CatalogBookCard>;
  ideasById: ReadonlyMap<string, KnowledgeIdeaReference>;
};

export type KnowledgeIdeaPage = KnowledgeRenderContext & {
  ideaId: string;
  slug: string;
  question: string;
  shortAnswer: string;
  seoTitle: string | null;
  seoDescription: string | null;
  createdAt: string;
  updatedAt: string;
  alternateSlugs: AlternateSlugs;
  metadataLocale: string;
  // Editorial order; unpublished or unlocalized targets are already dropped.
  books: CatalogBookCard[];
  relatedIdeas: KnowledgeIdeaSummary[];
  topics: KnowledgeTopicRef[];
};

export type KnowledgeArticlePage = KnowledgeRenderContext & {
  articleId: string;
  slug: string;
  title: string;
  excerpt: string;
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string;
  updatedAt: string;
  alternateSlugs: AlternateSlugs;
  metadataLocale: string;
  author: KnowledgeAuthorRef;
  books: CatalogBookCard[];
  ideas: KnowledgeIdeaSummary[];
  topics: KnowledgeTopicRef[];
};

// A backlink on a book or topic page. For an idea, title is the question, excerpt the short
// answer, and publishedAt is null.
export type KnowledgeLinkSummary = {
  kind: "idea" | "article";
  slug: string;
  title: string;
  excerpt: string;
  publishedAt: string | null;
};
