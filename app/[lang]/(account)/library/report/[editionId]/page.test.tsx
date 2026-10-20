import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReportErrorPage from "@/app/[lang]/(account)/library/report/[editionId]/page";
import { requireUser } from "@/lib/auth/session";
import { getReadableEdition } from "@/lib/data/library";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/library", () => ({ getReadableEdition: vi.fn() }));
vi.mock("@/app/[lang]/(account)/library/report/[editionId]/actions", () => ({ submitReportAction: vi.fn() }));

const editionId = "50000000-0000-4000-8000-000000000001";
const params = Promise.resolve({ lang: "en", editionId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getReadableEdition).mockResolvedValue({ title: "Harbour Lights", publicationId: "p" } as Awaited<ReturnType<typeof getReadableEdition>>);
});
afterEach(cleanup);

describe("ReportErrorPage", () => {
  it("asks for sign-in, returning to this very report", async () => {
    render(await ReportErrorPage({ params }));
    expect(requireUser).toHaveBeenCalledWith("en", `/en/library/report/${editionId}`);
  });

  it("names the book, says the editors read it, and shows where the reader was", async () => {
    render(await ReportErrorPage({ params, searchParams: Promise.resolve({ href: "OEBPS/c1.xhtml", progression: "0.4" }) }));
    expect(screen.getByText(/Harbour Lights/)).toBeInTheDocument();
    expect(screen.getByText(/not sent to the author/)).toBeInTheDocument();
    expect(screen.getByText("Where you were reading: 40%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send report" })).toBeInTheDocument();
  });

  it("is a 404 for an edition the reader does not hold, like one that does not exist", async () => {
    vi.mocked(getReadableEdition).mockResolvedValue(null);
    await expect(ReportErrorPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
