import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderComparePanel } from "@/components/reader/reader-compare-panel";
import type { ReaderLocator } from "@/lib/reader/types";

const publicationId = "c0000000-0000-4000-8000-000000000001";
const copy = { compareNone: "Nothing lines up here.", compareOpenOther: "Open in that edition", searching: "Searching…" };
const locator: ReaderLocator = {
  href: `/api/reader/publications/${publicationId}/resources/OEBPS/c1.xhtml`,
  progression: 0.25,
  totalProgression: 0.1,
  locations: {},
};
const passage = {
  targetPublicationId: "c0000000-0000-4000-8000-000000000002",
  targetEditionId: "e0000000-0000-4000-8000-000000000002",
  targetLanguageCode: "en",
  targetOrdinal: 7,
  text: "The aligned English passage.",
  confidence: 1,
};

afterEach(cleanup);

function renderPanel(response: Promise<unknown>, onOpenOther = vi.fn()) {
  const request = vi.fn().mockReturnValue(response);
  render(
    <ReaderComparePanel
      copy={copy}
      currentLocator={locator}
      locale="vi"
      onOpenOther={onOpenOther}
      publicationId={publicationId}
      request={request as never}
    />,
  );
  return { request, onOpenOther };
}

describe("ReaderComparePanel", () => {
  it("renders the aligned text in its language and links to it in the other edition", async () => {
    const { request, onOpenOther } = renderPanel(Promise.resolve({ passage }));

    const text = await screen.findByText(passage.text);
    expect(text.getAttribute("lang")).toBe("en");
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/api/reader/publications/${publicationId}/aligned?href=${encodeURIComponent(locator.href)}&progression=0.25`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const link = screen.getByRole("link", { name: copy.compareOpenOther });
    expect(link.getAttribute("href")).toBe(`/vi/read/editions/${passage.targetEditionId}?anchor=7`);
    fireEvent.click(link);
    expect(onOpenOther).toHaveBeenCalledWith(`/vi/read/editions/${passage.targetEditionId}?anchor=7`);
  });

  it("says nothing lines up when the lookup returns null", async () => {
    renderPanel(Promise.resolve({ passage: null }));
    expect(await screen.findByText(copy.compareNone)).toBeTruthy();
  });

  it("says nothing lines up when the lookup fails", async () => {
    renderPanel(Promise.reject(new Error("502")));
    expect(await screen.findByText(copy.compareNone)).toBeTruthy();
  });
});
