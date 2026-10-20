import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IdeaIndex } from "@/components/knowledge/idea-index";
import type { KnowledgeIdeaSummary } from "@/lib/knowledge/public-types";

afterEach(cleanup);

const habits = { slug: "habits", name: "Habits" };
const focus = { slug: "focus", name: "Focus" };

function idea(slug: string, question: string, topics = [habits]): KnowledgeIdeaSummary {
  return {
    ideaId: `id-${slug}`,
    slug,
    question,
    shortAnswer: `Answer to ${question}`,
    createdAt: "2026-09-01T00:00:00+00:00",
    updatedAt: "2026-09-02T00:00:00+00:00",
    alternateSlug: null,
    topics,
  };
}

const copy = { empty: "No ideas have been published yet.", otherTopic: "Other" };

describe("IdeaIndex", () => {
  it("lists an idea under every topic it belongs to, linking its question to the localized path", () => {
    const shared = idea("small-steps", "Why do small steps work?", [focus, habits]);
    render(
      <IdeaIndex
        copy={copy}
        groups={[
          { topic: focus, ideas: [shared] },
          { topic: habits, ideas: [shared, idea("streaks", "Do streaks help?")] },
        ]}
        locale="en"
      />,
    );

    const focusGroup = screen.getByRole("region", { name: "Focus" });
    const habitsGroup = screen.getByRole("region", { name: "Habits" });
    expect(within(focusGroup).getByRole("link", { name: "Why do small steps work?" })).toHaveAttribute(
      "href",
      "/en/ideas/small-steps",
    );
    expect(within(habitsGroup).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Why do small steps work?",
      "Do streaks help?",
    ]);
    expect(within(habitsGroup).getByText("Answer to Do streaks help?")).toBeInTheDocument();
  });

  it("shows ideas without a topic once, under one localized Other group placed last", () => {
    render(
      <IdeaIndex
        copy={{ ...copy, otherTopic: "Khác" }}
        groups={[
          { topic: habits, ideas: [idea("streaks", "Chuỗi ngày có giúp không?")] },
          { topic: null, ideas: [idea("loose", "Một câu hỏi lẻ?", [])] },
        ]}
        locale="vi"
      />,
    );

    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Habits", "Khác"]);
    const other = screen.getByRole("region", { name: "Khác" });
    expect(within(other).getByRole("link", { name: "Một câu hỏi lẻ?" })).toHaveAttribute("href", "/vi/ideas/loose");
  });

  it("never repeats an idea inside the same group", () => {
    const repeated = idea("streaks", "Do streaks help?");
    render(<IdeaIndex copy={copy} groups={[{ topic: habits, ideas: [repeated, repeated] }]} locale="en" />);

    expect(within(screen.getByRole("region", { name: "Habits" })).getAllByRole("link")).toHaveLength(1);
  });

  it("says so when nothing is published", () => {
    render(<IdeaIndex copy={copy} groups={[]} locale="en" />);

    expect(screen.getByText("No ideas have been published yet.")).toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
