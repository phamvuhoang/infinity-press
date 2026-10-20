import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createKnowledgeImageUploadAction } from "@/app/admin/knowledge/image-actions";
import { KnowledgeBlockEditor } from "@/components/admin/knowledge/knowledge-block-editor";
import { KnowledgeLocalizationForm } from "@/components/admin/knowledge/knowledge-localization-form";
import type { AdminFormState } from "@/lib/catalog/form";
import { knowledgeBlocksSchema, type KnowledgeBlock } from "@/lib/knowledge/blocks";
import { createClient } from "@/lib/supabase/client";

vi.mock("@/app/admin/knowledge/image-actions", () => ({ createKnowledgeImageUploadAction: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const otherIdea = "5a1b2c3d-0000-4000-8000-000000000002";
const bookA = "5a1b2c3d-0000-4000-8000-0000000000b1";
const bookB = "5a1b2c3d-0000-4000-8000-0000000000b2";
const imageKey = `knowledge/ideas/${ideaId}/6c2f1b3a-0000-4000-8000-000000000000.png`;
const books = [
  { id: bookA, title: "Sách một", published: true },
  { id: bookB, title: "Sách hai", published: false },
];
const ideas = [{ id: otherIdea, title: "Vì sao nên ghi chép?" }];
const paragraph: KnowledgeBlock = { type: "paragraph", content: [{ text: "Đọc chậm lại." }] };

function renderEditor(initialBlocks: KnowledgeBlock[] = [paragraph], errors: Record<string, string> = {}) {
  return render(
    <KnowledgeBlockEditor books={books} entityId={ideaId} errors={errors} ideas={ideas} initialBlocks={initialBlocks} kind="idea" />,
  );
}

function posted(): unknown[] {
  const input = document.querySelector<HTMLInputElement>("input[type='hidden'][name='bodyBlocks']");
  return JSON.parse(input?.value ?? "null") as unknown[];
}

const block = (index: number) => screen.getByRole("group", { name: new RegExp(`^⠿?\\s*Block ${index}:`) });

function addBlock(type: string) {
  fireEvent.change(screen.getByLabelText("New block type"), { target: { value: type } });
  fireEvent.click(screen.getByRole("button", { name: "Add block" }));
}

const change = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => vi.resetAllMocks());

it("starts from the stored blocks and posts them unchanged", () => {
  renderEditor();

  expect(posted()).toEqual([paragraph]);
  expect(within(block(1)).getByLabelText("Text")).toHaveValue("Đọc chậm lại.");
});

it("offers all eight block types and adds each in order", () => {
  renderEditor();

  const types = ["paragraph", "heading", "list", "quote", "book_quote", "image", "book_card", "idea_card"];
  expect(Array.from(screen.getByLabelText<HTMLSelectElement>("New block type").options).map((option) => option.value)).toEqual(types);
  for (const type of types) addBlock(type);

  expect(screen.getAllByTestId("knowledge-block")).toHaveLength(9);
  expect((posted() as { type: string }[]).map((value) => value.type)).toEqual(["paragraph", ...types]);
  expect(block(9)).toHaveTextContent("Block 9: Idea card");
});

it("edits inline runs with marks, an internal link, and an external link", () => {
  renderEditor();
  const first = within(block(1));

  fireEvent.click(first.getByLabelText("Emphasis"));
  fireEvent.click(first.getByRole("button", { name: "Add text run" }));
  const second = within(first.getByRole("group", { name: "Text run 2" }));
  change(second.getByLabelText("Text"), " một cuốn sách");
  fireEvent.click(second.getByLabelText("Strong"));
  change(second.getByLabelText("Link"), "internal");
  change(second.getByLabelText("Links to"), "idea");
  change(second.getByLabelText("Linked slug"), "vi-sao-nen-ghi-chep");
  fireEvent.click(first.getByRole("button", { name: "Add text run" }));
  const third = within(first.getByRole("group", { name: "Text run 3" }));
  change(third.getByLabelText("Text"), " nguồn");
  change(third.getByLabelText("Link"), "external");
  change(third.getByLabelText("URL"), "https://example.com/a");

  const expected = [
    {
      type: "paragraph",
      content: [
        { text: "Đọc chậm lại.", marks: ["emphasis"] },
        { text: " một cuốn sách", marks: ["strong"], link: { kind: "internal", entity: "idea", slug: "vi-sao-nen-ghi-chep" } },
        { text: " nguồn", link: { kind: "external", href: "https://example.com/a" } },
      ],
    },
  ];
  expect(posted()).toEqual(expected);
  expect(knowledgeBlocksSchema.safeParse(posted()).success).toBe(true);

  fireEvent.click(first.getByRole("button", { name: "Remove text run 3" }));
  expect((posted()[0] as { content: unknown[] }).content).toHaveLength(2);
});

it("adds and removes list items", () => {
  renderEditor([]);
  addBlock("list");
  const list = within(block(1));

  change(within(list.getByRole("group", { name: "Item 1" })).getByLabelText("Text"), "Một");
  fireEvent.click(list.getByRole("button", { name: "Add list item" }));
  change(within(list.getByRole("group", { name: "Item 2" })).getByLabelText("Text"), "Hai");
  fireEvent.click(list.getByLabelText("Numbered list"));

  expect(posted()).toEqual([{ type: "list", ordered: true, items: [[{ text: "Một" }], [{ text: "Hai" }]] }]);
  fireEvent.click(list.getByRole("button", { name: "Remove item 1" }));
  expect(posted()).toEqual([{ type: "list", ordered: true, items: [[{ text: "Hai" }]] }]);
  expect(knowledgeBlocksSchema.safeParse(posted()).success).toBe(true);
});

it("selects book and idea references for quotes and cards", () => {
  renderEditor([]);
  addBlock("heading");
  addBlock("quote");
  addBlock("quote");
  addBlock("book_quote");
  addBlock("book_card");
  addBlock("idea_card");

  change(within(block(1)).getByLabelText("Level"), "3");
  change(within(block(1)).getByLabelText("Heading text"), "Tóm tắt");
  change(within(block(2)).getByLabelText("Quote text"), "Chậm mà chắc.");
  change(within(block(2)).getByLabelText("Attribution"), "Tục ngữ");
  change(within(block(3)).getByLabelText("Quote text"), "Một câu trong sách.");
  change(within(block(3)).getByLabelText("Attributed to"), "book");
  change(within(block(3)).getByLabelText("Quoted book"), bookA);
  change(within(block(4)).getByLabelText("Quoted book"), bookB);
  change(within(block(4)).getByLabelText("Quote text"), "Trích dẫn.");
  change(within(block(4)).getByLabelText("Locator (optional)"), "Chương 3");
  change(within(block(5)).getByLabelText("Book"), bookB);
  change(within(block(6)).getByLabelText("Idea"), otherIdea);

  expect(within(block(4)).getByRole("option", { name: "Sách hai (not published)" })).toBeInTheDocument();
  expect(posted()).toEqual([
    { type: "heading", level: 3, text: "Tóm tắt" },
    { type: "quote", text: "Chậm mà chắc.", attribution: "Tục ngữ" },
    { type: "quote", text: "Một câu trong sách.", bookId: bookA },
    { type: "book_quote", bookId: bookB, text: "Trích dẫn.", locatorLabel: "Chương 3" },
    { type: "book_card", bookId: bookB },
    { type: "idea_card", ideaId: otherIdea },
  ]);
  expect(knowledgeBlocksSchema.safeParse(posted()).success).toBe(true);
});

it("counts a book quote in graphemes against the 300 limit", () => {
  renderEditor([]);
  addBlock("book_quote");

  change(within(block(1)).getByLabelText("Quote text"), "👩‍👩‍👧".repeat(3));

  expect(within(block(1)).getByText("3 / 300 characters")).toBeInTheDocument();
});

describe("image blocks", () => {
  function stubUpload(uploadError: unknown = null) {
    const uploadToSignedUrl = vi.fn(() => Promise.resolve({ data: { path: imageKey }, error: uploadError }));
    const from = vi.fn(() => ({ uploadToSignedUrl }));
    vi.mocked(createClient).mockReturnValue({ storage: { from } } as unknown as ReturnType<typeof createClient>);
    vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.resolve({ width: 1200, height: 800, close: vi.fn() })));
    return { from, uploadToSignedUrl };
  }

  it("reserves, uploads, measures, and inserts a typed image block", async () => {
    vi.mocked(createKnowledgeImageUploadAction).mockResolvedValue({ ok: true, storageKey: imageKey, path: imageKey, token: "t" });
    const storage = stubUpload();
    renderEditor([]);
    addBlock("image");
    const image = within(block(1));
    const file = new File(["png"], "figure.png", { type: "image/png" });

    fireEvent.change(image.getByLabelText("Image file"), { target: { files: [file] } });
    change(image.getByLabelText("Alt text"), "Biểu đồ đọc chậm");
    fireEvent.click(image.getByRole("button", { name: "Upload image" }));

    await waitFor(() => expect(image.getByRole("status")).toHaveTextContent("Image uploaded."));
    expect(createKnowledgeImageUploadAction).toHaveBeenCalledWith("idea", ideaId, { fileName: "figure.png", mimeType: "image/png", sizeBytes: 3 });
    expect(storage.from).toHaveBeenCalledWith("covers");
    expect(storage.uploadToSignedUrl).toHaveBeenCalledWith(imageKey, "t", file);
    expect(posted()).toEqual([{ type: "image", storageKey: imageKey, alt: "Biểu đồ đọc chậm", width: 1200, height: 800 }]);
    expect(knowledgeBlocksSchema.safeParse(posted()).success).toBe(true);
    expect(image.queryByLabelText("Image file")).not.toBeInTheDocument();
  });

  it("shows a refused reservation as an alert and inserts nothing", async () => {
    vi.mocked(createKnowledgeImageUploadAction).mockResolvedValue({ ok: false, error: "This entry no longer exists." });
    const storage = stubUpload();
    renderEditor([]);
    addBlock("image");
    const image = within(block(1));

    fireEvent.change(image.getByLabelText("Image file"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    fireEvent.click(image.getByRole("button", { name: "Upload image" }));

    await waitFor(() => expect(image.getByRole("alert")).toHaveTextContent("This entry no longer exists."));
    expect(storage.uploadToSignedUrl).not.toHaveBeenCalled();
    expect((posted()[0] as { storageKey: string }).storageKey).toBe("");
  });

  it("shows a failed storage upload as an alert", async () => {
    vi.mocked(createKnowledgeImageUploadAction).mockResolvedValue({ ok: true, storageKey: imageKey, path: imageKey, token: "t" });
    stubUpload({ message: "denied" });
    renderEditor([]);
    addBlock("image");
    const image = within(block(1));

    fireEvent.change(image.getByLabelText("Image file"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    fireEvent.click(image.getByRole("button", { name: "Upload image" }));

    await waitFor(() => expect(image.getByRole("alert")).toHaveTextContent("Upload to storage failed."));
  });

  it("refuses a file type the bucket rules would reject before reserving", () => {
    renderEditor([]);
    addBlock("image");
    const image = within(block(1));

    fireEvent.change(image.getByLabelText("Image file"), { target: { files: [new File(["x"], "a.gif", { type: "image/gif" })] } });

    expect(image.getByRole("alert")).toHaveTextContent("Upload a JPEG, PNG, or WebP image.");
    fireEvent.click(image.getByRole("button", { name: "Upload image" }));
    expect(createKnowledgeImageUploadAction).not.toHaveBeenCalled();
  });
});

describe("ordering and removal", () => {
  const three: KnowledgeBlock[] = [
    { type: "heading", level: 2, text: "Một" },
    { type: "heading", level: 2, text: "Hai" },
    { type: "heading", level: 2, text: "Ba" },
  ];
  const order = () => (posted() as { text: string }[]).map((value) => value.text);

  it("moves blocks with keyboard-reachable Move up and Move down controls", async () => {
    renderEditor(three);

    fireEvent.click(screen.getByRole("button", { name: "Move block 3 (Heading) up" }));
    expect(order()).toEqual(["Một", "Ba", "Hai"]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move block 2 (Heading) up" })));

    fireEvent.click(screen.getByRole("button", { name: "Move block 1 (Heading) down" }));
    expect(order()).toEqual(["Ba", "Một", "Hai"]);
    expect(screen.getByTestId("knowledge-block-announcement")).toHaveTextContent("Moved Heading block to position 2 of 3.");
    expect(screen.getByRole("button", { name: "Move block 1 (Heading) up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move block 3 (Heading) down" })).toBeDisabled();
  });

  it("reorders by dragging a block's handle onto another block", () => {
    renderEditor(three);
    const handles = screen.getAllByTestId("knowledge-block-handle");
    const targets = screen.getAllByTestId("knowledge-block");

    fireEvent.dragStart(handles[0]);
    fireEvent.dragOver(targets[2]);
    fireEvent.drop(targets[2]);

    expect(order()).toEqual(["Hai", "Ba", "Một"]);
  });

  it("removes a block", () => {
    renderEditor(three);

    fireEvent.click(screen.getByRole("button", { name: "Remove block 2 (Heading)" }));

    expect(order()).toEqual(["Một", "Ba"]);
    expect(screen.getAllByTestId("knowledge-block")).toHaveLength(2);
  });
});

it("shows each server error beside the block that caused it", () => {
  renderEditor([paragraph, { type: "heading", level: 2, text: "x" }], {
    bodyBlocks: "The content could not be read. Reload and try again.",
    "bodyBlocks.1.text": "HTML is not allowed. Use plain text.",
  });

  expect(within(block(2)).getByRole("alert")).toHaveTextContent("HTML is not allowed. Use plain text.");
  expect(within(block(1)).queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("The content could not be read. Reload and try again.")).toHaveAttribute("role", "alert");
});

it("keeps unsaved blocks and fields after a failed save, then posts them on retry", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return submissions.length === 1
      ? { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null }
      : { fieldErrors: {}, formError: null, savedAt: 1 };
  };
  const { container } = render(
    <KnowledgeLocalizationForm
      action={save}
      books={books}
      entityId={ideaId}
      ideas={ideas}
      kind="idea"
      locale="vi"
      localization={null}
    />,
  );

  change(screen.getByLabelText("Question (vi)"), "Vì sao nên đọc chậm?");
  change(screen.getByLabelText("Short answer (vi)"), "Để nhớ lâu.");
  change(screen.getByLabelText("Slug (vi)"), "doc-cham");
  addBlock("paragraph");
  change(within(block(1)).getByLabelText("Text"), "Bản nháp chưa lưu.");
  fireEvent.submit(container.querySelector("form")!);

  await screen.findByText("Something went wrong saving. Try again.");
  expect(screen.getByLabelText("Question (vi)")).toHaveValue("Vì sao nên đọc chậm?");
  expect(within(block(1)).getByLabelText("Text")).toHaveValue("Bản nháp chưa lưu.");
  expect(submissions[0].get("bodyBlocks")).toBe(JSON.stringify([{ type: "paragraph", content: [{ text: "Bản nháp chưa lưu." }] }]));

  fireEvent.submit(container.querySelector("form")!);
  await expect(screen.findByTestId("form-saved")).resolves.toHaveTextContent("Saved.");
  expect(submissions[1].get("bodyBlocks")).toBe(submissions[0].get("bodyBlocks"));
  expect(submissions[1].get("question")).toBe("Vì sao nên đọc chậm?");
});
