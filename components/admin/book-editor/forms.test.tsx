import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DetailsForm } from "./details-form";
import { LocalizationForm } from "./localization-form";
import { EditionForm, OfferForm } from "./edition-offer-forms";
import type { AdminEditionDTO } from "@/lib/data/admin-editions";

const languages = [{ code: "vi", name: "Vietnamese" }, { code: "ja", name: "Japanese" }];
const edition: AdminEditionDTO = {
  id: "edition",
  bookId: "book",
  languageCode: "vi",
  editionNumber: 1,
  isbn: null,
  publicationDate: null,
  introduction: null,
  contributors: [],
  status: "draft",
  isDefault: false,
  activePublicationId: null,
  sampleFull: false,
  identityLocked: false,
  sku: null,
  offers: [],
  editorial: { state: "unreviewed", textSourceNote: null, translationSource: null, rightsNote: null, territoryNote: null, textKind: null, reviewScope: "none", publicVersionNote: null, reviewedAt: null, reviewNote: null },
};
import { RelationsForm } from "./relations-form";
import type { AdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);
const action = async (): Promise<AdminFormState> => ({ fieldErrors: { canonicalKey: "Key is taken", originalLanguage: "Invalid language", primaryAuthorId: "Choose an author", "keyIdeas.1.summary": "Summary too long", "faq.2.answer": "Answer too long", languageCode: "Invalid language", isbn: "Invalid ISBN", editionNumber: "Invalid number", publicationDate: "Invalid date", contributors: "Invalid credits", introduction: "Too long", marketCode: "Invalid market", currency: "Invalid currency", priceMinor: "Invalid price", active: "Invalid status", "topicIds.1": "Invalid topic", seriesId: "Invalid series", seriesPosition: "Position taken" }, formError: null, savedAt: null });
const cases = [
  { name: "details", ui: <DetailsForm action={action} authors={[]} languages={[{ code: "vi", name: "Vietnamese" }, { code: "en", name: "English" }]} defaults={{ canonicalKey: "golden", originalLanguage: "vi", primaryAuthorId: "" }} />, labels: ["Canonical key", "Book language", "Primary author"] },
  { name: "localization", ui: <LocalizationForm action={action} locale="vi" localization={null} />, labels: ["Key ideas (vi)", "FAQ (vi)"] },
  { name: "edition", ui: <EditionForm action={action} edition={edition} languages={languages} />, labels: ["Edition language", "ISBN", "Edition number", "Publication date", "Credits", "Translation introduction"] },
  { name: "offer", ui: <OfferForm action={action} offer={{ id: "offer", marketCode: "VN", currency: "VND", priceMinor: 0, active: true, isDefault: true, sale: null, effectivePriceMinor: 0, saleState: "none" }} />, labels: ["Market", "Currency", "Price (minor units)", "Offer is active"] },
  { name: "relations", ui: <RelationsForm action={action} topics={[{ id: "topic", name: "Topic" }]} series={[]} defaults={{ topicIds: [], seriesId: null, seriesPosition: null }} />, labels: ["Topic", "Series", "Series position"] },
];
it.each(cases)("$name connects every invalid field to its inline error", async ({ ui, labels }) => {
  const { container } = render(ui);
  fireEvent.submit(container.querySelector("form")!);
  await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
  for (const label of labels) {
    const input = screen.getByLabelText(label, { exact: true });
    expect(input).toHaveAttribute("aria-invalid", "true");
    const ids = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids.some((id) => document.getElementById(id)?.getAttribute("role") === "alert")).toBe(true);
  }
});

it("disambiguates duplicate author names in the details form", () => {
  render(
    <DetailsForm
      action={action}
      authors={[
        { id: "author-one", name: "Shared Name", canonicalSlug: "shared-name-one" },
        { id: "author-two", name: "Shared Name", canonicalSlug: "shared-name-two" },
      ]}
      languages={[{ code: "vi", name: "Vietnamese" }]}
      defaults={{ canonicalKey: "golden", originalLanguage: "vi", primaryAuthorId: "author-one" }}
    />,
  );

  expect(screen.getByRole("option", { name: "Shared Name (shared-name-one)" })).toHaveValue("author-one");
  expect(screen.getByRole("option", { name: "Shared Name (shared-name-two)" })).toHaveValue("author-two");
});

const localizationFailures: AdminFormState[] = [
  { fieldErrors: { slug: "A book with this locale and slug already exists." }, formError: null, savedAt: null },
  { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null },
];
it.each(localizationFailures)("preserves localization drafts after $formError $fieldErrors.slug and saves the corrected retry", async (failure) => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return submissions.length === 1 ? failure : { fieldErrors: {}, formError: null, savedAt: 1 };
  };
  const { container } = render(<LocalizationForm action={save} locale="vi" localization={null} />);
  const drafts = [
    ["Title (vi)", "Unsaved title"],
    ["Slug (vi)", "taken-slug"],
    ["Description (vi)", "A description that must survive a failed save.\nSecond paragraph."],
    ["Key ideas (vi)", "First idea | summary\nSecond idea"],
    ["FAQ (vi)", "Q: Where?\nA: On the web."],
  ];
  for (const [label, value] of drafts) fireEvent.change(screen.getByLabelText(label, { exact: true }), { target: { value } });
  fireEvent.submit(container.querySelector("form")!);
  await screen.findByRole("alert");
  for (const [label, value] of drafts) expect(screen.getByLabelText(label, { exact: true })).toHaveValue(value);
  fireEvent.change(screen.getByLabelText("Slug (vi)"), { target: { value: "available-slug" } });
  fireEvent.submit(container.querySelector("form")!);
  await expect(screen.findByRole("status")).resolves.toHaveTextContent("Saved.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(submissions[1].get("slug")).toBe("available-slug");
  expect(submissions[1].get("description")).toBe(drafts[2][1]);
  expect(submissions[1].get("keyIdeas")).toBe(drafts[3][1]);
  expect(submissions[1].get("faq")).toBe(drafts[4][1]);
  expect(screen.getByLabelText("Description (vi)", { exact: true })).toHaveValue(drafts[2][1]);
});

it("preserves selected topics and series after missing-position validation and saves the corrected retry", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return data.get("seriesPosition") ? { fieldErrors: {}, formError: null, savedAt: 1 } : { fieldErrors: { seriesPosition: "Enter the book's position in the series." }, formError: null, savedAt: null };
  };
  const { container } = render(<RelationsForm action={save} topics={[{ id: "old", name: "Old topic" }, { id: "new", name: "New topic" }]} series={[{ id: "series", name: "Chosen series" }]} defaults={{ topicIds: ["old"], seriesId: null, seriesPosition: null }} />);
  fireEvent.click(screen.getByLabelText("Old topic"));
  fireEvent.click(screen.getByLabelText("New topic"));
  fireEvent.change(screen.getByLabelText("Series", { exact: true }), { target: { value: "series" } });
  fireEvent.submit(container.querySelector("form")!);
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Old topic")).not.toBeChecked();
  expect(screen.getByLabelText("New topic")).toBeChecked();
  expect(screen.getByLabelText("Series", { exact: true })).toHaveValue("series");
  fireEvent.change(screen.getByLabelText("Series position"), { target: { value: "2" } });
  fireEvent.submit(container.querySelector("form")!);
  await expect(screen.findByRole("status")).resolves.toHaveTextContent("Saved.");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(submissions[1].getAll("topicIds")).toEqual(["new"]);
  expect(submissions[1].get("seriesId")).toBe("series");
  expect(submissions[1].get("seriesPosition")).toBe("2");
  expect(screen.getByLabelText("New topic")).toBeChecked();
  expect(screen.getByLabelText("Series position")).toHaveValue(2);
});

it.each([
  { name: "details", ui: <DetailsForm action={action} authors={[{ id: "author", name: "Author", canonicalSlug: "author" }]} languages={[{ code: "vi", name: "Vietnamese" }]} defaults={{ canonicalKey: "old-key", originalLanguage: "vi", primaryAuthorId: "author" }} />, label: "Canonical key", value: "draft-key" },
  { name: "edition", ui: <EditionForm action={action} edition={edition} languages={languages} />, label: "Edition number", value: 2 },
  { name: "offer", ui: <OfferForm action={action} offer={{ id: "offer", marketCode: "VN", currency: "VND", priceMinor: 0, active: true, isDefault: true, sale: null, effectivePriceMinor: 0, saleState: "none" }} />, label: "Price (minor units)", value: 2500 },
])("preserves $name drafts after failed saves", async ({ ui, label, value }) => {
  const { container } = render(ui);
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  if (label === "Price (minor units)") fireEvent.click(screen.getByLabelText("Offer is active"));
  fireEvent.submit(container.querySelector("form")!);
  await screen.findAllByRole("alert");
  expect(screen.getByLabelText(label)).toHaveValue(value);
  if (label === "Price (minor units)") expect(screen.getByLabelText("Offer is active")).not.toBeChecked();
});

// S19 review fix: only the field the chosen kind uses is enabled, so a stale 100% cannot block
// a "No sale" or "Amount off" submit through the input's max.
it("enables only the sale fields the chosen discount kind uses", () => {
  const offer = { id: "offer", marketCode: "VN", currency: "VND", priceMinor: 129000, active: true, isDefault: false, sale: { kind: "percent" as const, percentOff: 30, amountOffMinor: null, startsAt: null, endsAt: null }, effectivePriceMinor: 90300, saleState: "running" as const };
  render(<OfferForm action={action} offer={offer} />);
  const kind = screen.getByLabelText("Discount");
  const percent = screen.getByLabelText("Percentage off");
  const amount = screen.getByLabelText("Amount off (minor units)");
  const ends = screen.getByLabelText("Ends (UTC)");
  expect([percent, amount, ends].map((input) => (input as HTMLInputElement).disabled)).toEqual([false, true, false]);
  fireEvent.change(kind, { target: { value: "fixed" } });
  expect([percent, amount, ends].map((input) => (input as HTMLInputElement).disabled)).toEqual([true, false, false]);
  fireEvent.change(kind, { target: { value: "none" } });
  expect([percent, amount, ends].map((input) => (input as HTMLInputElement).disabled)).toEqual([true, true, true]);
});
