import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { publishKnowledgeAction, unpublishKnowledgeAction } from "@/app/admin/knowledge/actions";
import { KnowledgePublishPanel } from "@/components/admin/knowledge/knowledge-publish-panel";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/admin/knowledge/actions", () => ({ publishKnowledgeAction: vi.fn(), unpublishKnowledgeAction: vi.fn() }));

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const articleId = "5a1b2c3d-0000-4000-8000-0000000000a0";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

it("disables publishing an idea until readiness is empty and links each issue to its section", () => {
  render(
    <KnowledgePublishPanel id={ideaId} issues={["missing_localization", "missing_blocks", "missing_related_book"]} kind="idea" status="draft" />,
  );

  expect(screen.getByRole("button", { name: "Publish idea" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Add a localization with a slug, question, and short answer." })).toHaveAttribute(
    "href",
    "#localizations",
  );
  expect(screen.getByRole("link", { name: "Add at least one content block to a complete localization." })).toHaveAttribute(
    "href",
    "#localizations",
  );
  expect(screen.getByRole("link", { name: "Relate a published book that is localized in every locale this idea has." })).toHaveAttribute("href", "#relations");
});

it("uses the article's own readiness copy", () => {
  render(<KnowledgePublishPanel id={articleId} issues={["missing_localization"]} kind="article" status="draft" />);

  expect(screen.getByRole("link", { name: "Add a localization with a slug, title, and excerpt." })).toBeVisible();
  expect(screen.getByRole("button", { name: "Publish article" })).toBeDisabled();
});

it("publishes a ready idea through the idea action and announces success", async () => {
  vi.mocked(publishKnowledgeAction).mockResolvedValue({ ok: true, message: "Idea published." });
  render(<KnowledgePublishPanel id={ideaId} issues={[]} kind="idea" status="draft" />);

  fireEvent.click(screen.getByRole("button", { name: "Publish idea" }));

  expect(window.confirm).toHaveBeenCalledWith("Publish this idea? It becomes visible on the storefront.");
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Idea published."));
  expect(publishKnowledgeAction).toHaveBeenCalledWith("idea", ideaId);
  expect(unpublishKnowledgeAction).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledOnce();
});

it("unpublishes a published article even with readiness issues", async () => {
  vi.mocked(unpublishKnowledgeAction).mockResolvedValue({ ok: true, message: "Article unpublished." });
  render(<KnowledgePublishPanel id={articleId} issues={["missing_blocks"]} kind="article" status="published" />);

  fireEvent.click(screen.getByRole("button", { name: "Unpublish article" }));

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Article unpublished."));
  expect(unpublishKnowledgeAction).toHaveBeenCalledWith("article", articleId);
  expect(publishKnowledgeAction).not.toHaveBeenCalled();
});

it("shows the database's readiness issues when it refuses to publish", async () => {
  vi.mocked(publishKnowledgeAction).mockResolvedValue({
    ok: false,
    error: "This entry is not ready to publish.",
    issues: ["missing_related_book"],
  });
  render(<KnowledgePublishPanel id={ideaId} issues={[]} kind="idea" status="draft" />);

  fireEvent.click(screen.getByRole("button", { name: "Publish idea" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This entry is not ready to publish."));
  expect(screen.getByRole("link", { name: "Relate a published book that is localized in every locale this idea has." })).toHaveAttribute("href", "#relations");
  expect(refresh).not.toHaveBeenCalled();
});

it("does nothing when the confirmation is cancelled", () => {
  vi.mocked(window.confirm).mockReturnValue(false);
  render(<KnowledgePublishPanel id={ideaId} issues={[]} kind="idea" status="draft" />);

  fireEvent.click(screen.getByRole("button", { name: "Publish idea" }));

  expect(publishKnowledgeAction).not.toHaveBeenCalled();
});

it("recovers a rejected action with a safe error", async () => {
  vi.mocked(publishKnowledgeAction).mockRejectedValue(new Error("private transport detail"));
  render(<KnowledgePublishPanel id={ideaId} issues={[]} kind="idea" status="draft" />);

  fireEvent.click(screen.getByRole("button", { name: "Publish idea" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again."));
  expect(screen.queryByText(/private transport/)).not.toBeInTheDocument();
});
