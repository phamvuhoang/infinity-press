import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MyQuestions } from "@/components/account/my-questions";
import type { MyQuestion } from "@/lib/data/questions";

afterEach(cleanup);

const copy = {
  mineTitle: "Your questions",
  readAnswer: "Read the answer",
  states: { new: "Waiting", answered: "Answered", archived: "Closed" },
};

function answered(locale: MyQuestion["locale"], slug: string): MyQuestion {
  return {
    id: `q-${locale}`,
    body: "Why read slowly?",
    locale,
    status: "answered",
    createdAt: "2026-10-01T00:00:00Z",
    target: { kind: "idea", title: "Slow reading" },
    answer: { slug },
  };
}

describe("MyQuestions", () => {
  // The answer slug belongs to the localization in the question's locale, not the page's.
  it("links the answer in the question's locale", () => {
    render(<MyQuestions copy={copy} locale="en" questions={[answered("vi", "doc-cham")]} />);
    expect(screen.getByRole("link", { name: "Read the answer" })).toHaveAttribute("href", "/vi/ideas/doc-cham");
  });

  it("links the answer in the page locale when the question was asked there", () => {
    render(<MyQuestions copy={copy} locale="en" questions={[answered("en", "slow-reading")]} />);
    expect(screen.getByRole("link", { name: "Read the answer" })).toHaveAttribute("href", "/en/ideas/slow-reading");
  });
});
