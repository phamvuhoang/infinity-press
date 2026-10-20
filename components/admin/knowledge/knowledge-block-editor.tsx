"use client";

import Image from "next/image";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";

import { createKnowledgeImageUploadAction } from "@/app/admin/knowledge/image-actions";
import { FieldError } from "@/components/admin/form-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { COVERS_BUCKET, coverPublicUrl } from "@/lib/catalog/covers";
import type { FieldErrors } from "@/lib/catalog/form";
import { COVER_MIME_TYPES, MAX_COVER_SIZE_BYTES } from "@/lib/catalog/schemas";
import { knowledgeEntityKinds, type KnowledgeBlock, type KnowledgeEntityKind, type InlineRun } from "@/lib/knowledge/blocks";
import { MAX_BOOK_QUOTE_GRAPHEMES, splitGraphemes } from "@/lib/reader/quote";
import { createClient } from "@/lib/supabase/client";

// The typed block editor. It edits the same discriminated union the server validates
// (lib/knowledge/blocks.ts) through ordinary form fields - never a contentEditable or an HTML
// surface - and posts the whole list as one JSON string in a hidden field. Drafts may be
// incomplete while being edited; the Server Action's schema is what decides whether they save.

export type KnowledgeBookOption = { id: string; title: string; published: boolean };
export type KnowledgeIdeaOption = { id: string; title: string };

type BlockType = KnowledgeBlock["type"];
type Mark = "emphasis" | "strong";

type RunDraft = {
  text: string;
  marks: Mark[];
  linkKind: "none" | "internal" | "external";
  entity: KnowledgeEntityKind;
  slug: string;
  href: string;
};

type BlockDraft =
  | { type: "paragraph"; content: RunDraft[] }
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "list"; ordered: boolean; items: RunDraft[][] }
  | { type: "quote"; text: string; source: "person" | "book"; attribution: string; bookId: string }
  | { type: "book_quote"; bookId: string; text: string; locatorLabel: string }
  | { type: "image"; storageKey: string; alt: string; width: number; height: number }
  | { type: "book_card"; bookId: string }
  | { type: "idea_card"; ideaId: string };

type Entry = { key: string; draft: BlockDraft };

export const blockTypeLabels: Record<BlockType, string> = {
  paragraph: "Paragraph",
  heading: "Heading",
  list: "List",
  quote: "Quote",
  book_quote: "Book quote",
  image: "Image",
  book_card: "Book card",
  idea_card: "Idea card",
};

const entityLabels: Record<KnowledgeEntityKind, string> = {
  book: "Book",
  idea: "Idea",
  article: "Article",
  author: "Author",
  series: "Series",
  topic: "Topic",
};

const emptyRun = (): RunDraft => ({ text: "", marks: [], linkKind: "none", entity: "book", slug: "", href: "" });

function emptyDraft(type: BlockType): BlockDraft {
  switch (type) {
    case "paragraph":
      return { type, content: [emptyRun()] };
    case "heading":
      return { type, level: 2, text: "" };
    case "list":
      return { type, ordered: false, items: [[emptyRun()]] };
    case "quote":
      return { type, text: "", source: "person", attribution: "", bookId: "" };
    case "book_quote":
      return { type, bookId: "", text: "", locatorLabel: "" };
    case "image":
      return { type, storageKey: "", alt: "", width: 0, height: 0 };
    case "book_card":
      return { type, bookId: "" };
    case "idea_card":
      return { type, ideaId: "" };
  }
}

function runToDraft(run: InlineRun): RunDraft {
  const draft = { ...emptyRun(), text: run.text, marks: [...(run.marks ?? [])] };
  if (run.link?.kind === "internal") return { ...draft, linkKind: "internal", entity: run.link.entity, slug: run.link.slug };
  if (run.link?.kind === "external") return { ...draft, linkKind: "external", href: run.link.href };
  return draft;
}

function toDraft(block: KnowledgeBlock): BlockDraft {
  switch (block.type) {
    case "paragraph":
      return { type: "paragraph", content: block.content.map(runToDraft) };
    case "heading":
      return { type: "heading", level: block.level, text: block.text };
    case "list":
      return { type: "list", ordered: block.ordered, items: block.items.map((item) => item.map(runToDraft)) };
    case "quote":
      return {
        type: "quote",
        text: block.text,
        source: block.bookId ? "book" : "person",
        attribution: block.attribution ?? "",
        bookId: block.bookId ?? "",
      };
    case "book_quote":
      return { type: "book_quote", bookId: block.bookId, text: block.text, locatorLabel: block.locatorLabel ?? "" };
    case "image":
      return { type: "image", storageKey: block.storageKey, alt: block.alt, width: block.width, height: block.height };
    case "book_card":
      return { type: "book_card", bookId: block.bookId };
    case "idea_card":
      return { type: "idea_card", ideaId: block.ideaId };
  }
}

const markOrder: Mark[] = ["emphasis", "strong"];

function serializeRun(run: RunDraft) {
  const marks = markOrder.filter((mark) => run.marks.includes(mark));
  return {
    text: run.text,
    ...(marks.length > 0 ? { marks } : {}),
    ...(run.linkKind === "internal" ? { link: { kind: "internal", entity: run.entity, slug: run.slug.trim() } } : {}),
    ...(run.linkKind === "external" ? { link: { kind: "external", href: run.href.trim() } } : {}),
  };
}

// Only the fields the chosen shape owns are posted, so the strict schema never sees a stray key:
// a quote carries exactly one attribution source, and an empty locator is omitted, not blank.
function serializeDraft(draft: BlockDraft): unknown {
  switch (draft.type) {
    case "paragraph":
      return { type: draft.type, content: draft.content.map(serializeRun) };
    case "heading":
      return { type: draft.type, level: draft.level, text: draft.text };
    case "list":
      return { type: draft.type, ordered: draft.ordered, items: draft.items.map((item) => item.map(serializeRun)) };
    case "quote":
      return draft.source === "book"
        ? { type: draft.type, text: draft.text, bookId: draft.bookId }
        : { type: draft.type, text: draft.text, attribution: draft.attribution };
    case "book_quote":
      return {
        type: draft.type,
        bookId: draft.bookId,
        text: draft.text,
        ...(draft.locatorLabel.trim() ? { locatorLabel: draft.locatorLabel.trim() } : {}),
      };
    case "image":
      return { type: draft.type, storageKey: draft.storageKey, alt: draft.alt, width: draft.width, height: draft.height };
    case "book_card":
      return { type: draft.type, bookId: draft.bookId };
    case "idea_card":
      return { type: draft.type, ideaId: draft.ideaId };
  }
}

// The first error the server reported for block `index`, if any.
function blockError(errors: FieldErrors, name: string, index: number): string | undefined {
  const prefix = `${name}.${index}`;
  return Object.entries(errors).find(([key]) => key === prefix || key.startsWith(`${prefix}.`))?.[1];
}

async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

function validateImage(file: File): string | null {
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) return "Upload a JPEG, PNG, or WebP image.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_COVER_SIZE_BYTES) return "Images must be 5 MB or smaller.";
  return null;
}

function BookSelect({
  id,
  label,
  value,
  books,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  books: KnowledgeBookOption[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect id={id} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">Choose a book</option>
        {books.map((book) => (
          <option key={book.id} value={book.id}>
            {book.published ? book.title : `${book.title} (not published)`}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function GraphemeCount({ text }: { text: string }) {
  const count = splitGraphemes(text).length;
  return (
    <p className={`text-[0.8125rem] ${count > MAX_BOOK_QUOTE_GRAPHEMES ? "text-error" : "text-sage-text"}`}>
      {count} / {MAX_BOOK_QUOTE_GRAPHEMES} characters
    </p>
  );
}

// One run of inline text: its words, its marks, and at most one link. A paragraph or a list item is
// a sequence of these, which is how part of a sentence can be emphasized or linked without markup.
function RunFields({
  idPrefix,
  index,
  run,
  canRemove,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  index: number;
  run: RunDraft;
  canRemove: boolean;
  onChange: (run: RunDraft) => void;
  onRemove: () => void;
}) {
  const id = `${idPrefix}-run-${index}`;
  const toggle = (mark: Mark, on: boolean) =>
    onChange({ ...run, marks: on ? [...run.marks.filter((value) => value !== mark), mark] : run.marks.filter((value) => value !== mark) });

  return (
    <fieldset className="min-w-0 space-y-3 border-l border-sand pl-4">
      <legend className="text-[0.75rem] text-sage-text">{`Text run ${index + 1}`}</legend>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={`${id}-text`}>Text</Label>
        <Textarea id={`${id}-text`} onChange={(event) => onChange({ ...run, text: event.target.value })} rows={2} value={run.text} />
      </div>
      <div className="flex flex-wrap gap-x-6">
        {markOrder.map((mark) => (
          <label className="flex min-h-11 items-center gap-2 text-sm" key={mark}>
            <input
              checked={run.marks.includes(mark)}
              className="size-4 accent-forest"
              onChange={(event) => toggle(mark, event.target.checked)}
              type="checkbox"
            />
            {mark === "emphasis" ? "Emphasis" : "Strong"}
          </label>
        ))}
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`${id}-link`}>Link</Label>
          <NativeSelect
            id={`${id}-link`}
            onChange={(event) => onChange({ ...run, linkKind: event.target.value as RunDraft["linkKind"] })}
            value={run.linkKind}
          >
            <option value="none">No link</option>
            <option value="internal">Internal page</option>
            <option value="external">External URL</option>
          </NativeSelect>
        </div>
        {run.linkKind === "internal" ? (
          <>
            <div className="min-w-0 space-y-2">
              <Label htmlFor={`${id}-entity`}>Links to</Label>
              <NativeSelect
                id={`${id}-entity`}
                onChange={(event) => onChange({ ...run, entity: event.target.value as KnowledgeEntityKind })}
                value={run.entity}
              >
                {knowledgeEntityKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {entityLabels[kind]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="min-w-0 space-y-2 sm:col-span-2">
              <Label htmlFor={`${id}-slug`}>Linked slug</Label>
              <Input id={`${id}-slug`} onChange={(event) => onChange({ ...run, slug: event.target.value })} value={run.slug} />
              <p className="text-[0.8125rem] text-sage-text">The slug in this language; the link follows it to the right page.</p>
            </div>
          </>
        ) : null}
        {run.linkKind === "external" ? (
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${id}-href`}>URL</Label>
            <Input
              id={`${id}-href`}
              inputMode="url"
              onChange={(event) => onChange({ ...run, href: event.target.value })}
              placeholder="https://"
              value={run.href}
            />
          </div>
        ) : null}
      </div>
      {canRemove ? (
        <Button onClick={onRemove} size="sm" type="button" variant="ghost">
          {`Remove text run ${index + 1}`}
        </Button>
      ) : null}
    </fieldset>
  );
}

function RunsEditor({ idPrefix, runs, onChange }: { idPrefix: string; runs: RunDraft[]; onChange: (runs: RunDraft[]) => void }) {
  return (
    <div className="min-w-0 space-y-3">
      {runs.map((run, index) => (
        <RunFields
          canRemove={runs.length > 1}
          idPrefix={idPrefix}
          index={index}
          key={index}
          onChange={(next) => onChange(runs.map((value, position) => (position === index ? next : value)))}
          onRemove={() => onChange(runs.filter((_value, position) => position !== index))}
          run={run}
        />
      ))}
      <Button onClick={() => onChange([...runs, emptyRun()])} size="sm" type="button" variant="outline">
        Add text run
      </Button>
    </div>
  );
}

function ImageFields({
  idPrefix,
  kind,
  entityId,
  draft,
  onChange,
}: {
  idPrefix: string;
  kind: "idea" | "article";
  entityId: string;
  draft: Extract<BlockDraft, { type: "image" }>;
  onChange: (draft: BlockDraft) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "saved"; text: string } | null>(null);

  // Reserve a signed upload, send the file straight to storage, measure it, and only then write the
  // typed block - so a block never names an object that did not land.
  async function upload() {
    if (!file) return;
    const invalid = validateImage(file);
    if (invalid) {
      setMessage({ kind: "error", text: invalid });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const reservation = await createKnowledgeImageUploadAction(kind, entityId, {
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      if (!reservation.ok) {
        setMessage({ kind: "error", text: reservation.error });
        return;
      }
      const [{ error }, size] = await Promise.all([
        createClient().storage.from(COVERS_BUCKET).uploadToSignedUrl(reservation.path, reservation.token, file),
        imageSize(file),
      ]);
      if (error) {
        setMessage({ kind: "error", text: "Upload to storage failed. You can retry." });
        return;
      }
      if (!size) {
        setMessage({ kind: "error", text: "The image's size could not be read. Try another file." });
        return;
      }
      onChange({ ...draft, storageKey: reservation.storageKey, ...size });
      setFile(null);
      setMessage({ kind: "saved", text: "Image uploaded. Save the content to keep it." });
    } catch {
      setMessage({ kind: "error", text: "Something went wrong uploading the image. Try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0 space-y-3">
      {draft.storageKey ? (
        <div className="space-y-2">
          <Image
            alt={draft.alt}
            className="h-auto max-h-48 w-auto max-w-full bg-surface"
            height={draft.height}
            src={coverPublicUrl(draft.storageKey)}
            unoptimized
            width={draft.width}
          />
          <p className="text-[0.8125rem] text-sage-text">{`${draft.width} × ${draft.height}`}</p>
        </div>
      ) : (
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`${idPrefix}-file`}>Image file</Label>
          <Input
            accept={COVER_MIME_TYPES.join(",")}
            disabled={busy}
            id={`${idPrefix}-file`}
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              setFile(selected);
              const invalid = selected ? validateImage(selected) : null;
              setMessage(invalid ? { kind: "error", text: invalid } : null);
            }}
            type="file"
          />
        </div>
      )}
      <div className="min-w-0 space-y-2">
        <Label htmlFor={`${idPrefix}-alt`}>Alt text</Label>
        <Input id={`${idPrefix}-alt`} onChange={(event) => onChange({ ...draft, alt: event.target.value })} value={draft.alt} />
      </div>
      {draft.storageKey ? null : (
        <Button disabled={!file || busy} onClick={() => void upload()} size="sm" type="button" variant="outline">
          {busy ? "Uploading…" : "Upload image"}
        </Button>
      )}
      {message ? (
        <p
          className={message.kind === "error" ? "text-[0.8125rem] text-error" : "text-[0.8125rem] text-success"}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function BlockFields({
  idPrefix,
  kind,
  entityId,
  draft,
  books,
  ideas,
  onChange,
}: {
  idPrefix: string;
  kind: "idea" | "article";
  entityId: string;
  draft: BlockDraft;
  books: KnowledgeBookOption[];
  ideas: KnowledgeIdeaOption[];
  onChange: (draft: BlockDraft) => void;
}) {
  switch (draft.type) {
    case "paragraph":
      return <RunsEditor idPrefix={idPrefix} onChange={(content) => onChange({ ...draft, content })} runs={draft.content} />;
    case "heading":
      return (
        <div className="grid min-w-0 gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${idPrefix}-level`}>Level</Label>
            <NativeSelect
              id={`${idPrefix}-level`}
              onChange={(event) => onChange({ ...draft, level: event.target.value === "3" ? 3 : 2 })}
              value={String(draft.level)}
            >
              <option value="2">Heading 2</option>
              <option value="3">Heading 3</option>
            </NativeSelect>
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${idPrefix}-text`}>Heading text</Label>
            <Input id={`${idPrefix}-text`} onChange={(event) => onChange({ ...draft, text: event.target.value })} value={draft.text} />
          </div>
        </div>
      );
    case "list":
      return (
        <div className="min-w-0 space-y-4">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              checked={draft.ordered}
              className="size-4 accent-forest"
              onChange={(event) => onChange({ ...draft, ordered: event.target.checked })}
              type="checkbox"
            />
            Numbered list
          </label>
          {draft.items.map((item, index) => (
            <fieldset className="min-w-0 space-y-3 border-t border-sand pt-3" key={index}>
              <legend className="text-[0.8125rem] font-medium">{`Item ${index + 1}`}</legend>
              <RunsEditor
                idPrefix={`${idPrefix}-item-${index}`}
                onChange={(runs) => onChange({ ...draft, items: draft.items.map((value, position) => (position === index ? runs : value)) })}
                runs={item}
              />
              {draft.items.length > 1 ? (
                <Button
                  onClick={() => onChange({ ...draft, items: draft.items.filter((_value, position) => position !== index) })}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {`Remove item ${index + 1}`}
                </Button>
              ) : null}
            </fieldset>
          ))}
          <Button onClick={() => onChange({ ...draft, items: [...draft.items, [emptyRun()]] })} size="sm" type="button" variant="outline">
            Add list item
          </Button>
        </div>
      );
    case "quote":
      return (
        <div className="min-w-0 space-y-3">
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${idPrefix}-text`}>Quote text</Label>
            <Textarea id={`${idPrefix}-text`} onChange={(event) => onChange({ ...draft, text: event.target.value })} rows={3} value={draft.text} />
            {draft.source === "book" ? <GraphemeCount text={draft.text} /> : null}
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${idPrefix}-source`}>Attributed to</Label>
            <NativeSelect
              id={`${idPrefix}-source`}
              onChange={(event) => onChange({ ...draft, source: event.target.value === "book" ? "book" : "person" })}
              value={draft.source}
            >
              <option value="person">A person or source</option>
              <option value="book">A book</option>
            </NativeSelect>
          </div>
          {draft.source === "book" ? (
            <BookSelect books={books} id={`${idPrefix}-book`} label="Quoted book" onChange={(bookId) => onChange({ ...draft, bookId })} value={draft.bookId} />
          ) : (
            <div className="min-w-0 space-y-2">
              <Label htmlFor={`${idPrefix}-attribution`}>Attribution</Label>
              <Input
                id={`${idPrefix}-attribution`}
                onChange={(event) => onChange({ ...draft, attribution: event.target.value })}
                value={draft.attribution}
              />
            </div>
          )}
        </div>
      );
    case "book_quote":
      return (
        <div className="min-w-0 space-y-3">
          <BookSelect books={books} id={`${idPrefix}-book`} label="Quoted book" onChange={(bookId) => onChange({ ...draft, bookId })} value={draft.bookId} />
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${idPrefix}-text`}>Quote text</Label>
            <Textarea id={`${idPrefix}-text`} onChange={(event) => onChange({ ...draft, text: event.target.value })} rows={3} value={draft.text} />
            <GraphemeCount text={draft.text} />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${idPrefix}-locator`}>Locator (optional)</Label>
            <Input
              id={`${idPrefix}-locator`}
              onChange={(event) => onChange({ ...draft, locatorLabel: event.target.value })}
              placeholder="Chapter 3"
              value={draft.locatorLabel}
            />
          </div>
        </div>
      );
    case "image":
      return <ImageFields draft={draft} entityId={entityId} idPrefix={idPrefix} kind={kind} onChange={onChange} />;
    case "book_card":
      return <BookSelect books={books} id={`${idPrefix}-book`} label="Book" onChange={(bookId) => onChange({ ...draft, bookId })} value={draft.bookId} />;
    case "idea_card":
      return (
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`${idPrefix}-idea`}>Idea</Label>
          <NativeSelect id={`${idPrefix}-idea`} onChange={(event) => onChange({ ...draft, ideaId: event.target.value })} value={draft.ideaId}>
            <option value="">Choose an idea</option>
            {ideas.map((idea) => (
              <option key={idea.id} value={idea.id}>
                {idea.title}
              </option>
            ))}
          </NativeSelect>
        </div>
      );
  }
}

export function KnowledgeBlockEditor({
  kind,
  entityId,
  initialBlocks,
  books,
  ideas,
  errors,
  name = "bodyBlocks",
}: {
  kind: "idea" | "article";
  entityId: string;
  initialBlocks: KnowledgeBlock[];
  books: KnowledgeBookOption[];
  ideas: KnowledgeIdeaOption[];
  errors: FieldErrors;
  name?: string;
}) {
  const baseId = useId();
  const nextKey = useRef(initialBlocks.length);
  const [entries, setEntries] = useState<Entry[]>(() => initialBlocks.map((block, index) => ({ key: `b${index}`, draft: toDraft(block) })));
  const [newType, setNewType] = useState<BlockType>("paragraph");
  const [announcement, setAnnouncement] = useState("");
  const dragging = useRef<number | null>(null);
  // A one-shot instruction to the DOM after a move re-renders: keep focus on the moved block's
  // control, or its opposite at a boundary, so keyboard users are not dropped onto <body>.
  const pendingFocus = useRef<string | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement | null>());

  useEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    pendingFocus.current = null;
    controls.current.get(key)?.focus();
  }, [entries]);

  const label = (entry: Entry, index: number) => `block ${index + 1} (${blockTypeLabels[entry.draft.type]})`;

  function update(key: string, draft: BlockDraft) {
    setEntries((current) => current.map((entry) => (entry.key === key ? { ...entry, draft } : entry)));
  }

  function moveTo(from: number, to: number) {
    if (from === to || to < 0 || to >= entries.length) return;
    const moved = entries[from];
    setEntries((current) => {
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setAnnouncement(`Moved ${blockTypeLabels[moved.draft.type]} block to position ${to + 1} of ${entries.length}.`);
    return moved;
  }

  function move(index: number, offset: -1 | 1) {
    const moved = moveTo(index, index + offset);
    if (!moved) return;
    const target = index + offset;
    const atBoundary = target === 0 || target === entries.length - 1;
    const direction = offset === -1 ? "up" : "down";
    const opposite = offset === -1 ? "down" : "up";
    pendingFocus.current = `${moved.key}:${atBoundary ? opposite : direction}`;
  }

  function remove(index: number) {
    const removed = entries[index];
    setEntries((current) => current.filter((_entry, position) => position !== index));
    setAnnouncement(`Removed ${blockTypeLabels[removed.draft.type]} block.`);
  }

  function add() {
    const key = `b${nextKey.current++}`;
    setEntries((current) => [...current, { key, draft: emptyDraft(newType) }]);
    setAnnouncement(`Added a ${blockTypeLabels[newType]} block at position ${entries.length + 1}.`);
  }

  function onDrop(event: DragEvent<HTMLLIElement>, index: number) {
    event.preventDefault();
    const from = dragging.current;
    dragging.current = null;
    if (from !== null) moveTo(from, index);
  }

  const serialized = JSON.stringify(entries.map((entry) => serializeDraft(entry.draft)));
  const listError = errors[name];

  return (
    <div className="min-w-0 space-y-5">
      <input name={name} type="hidden" value={serialized} />
      <FieldError id={`${baseId}-error`} message={listError} />
      {entries.length === 0 ? <p className="text-sm text-sage-text">No content blocks yet.</p> : null}
      <ol className="min-w-0 space-y-6">
        {entries.map((entry, index) => {
          const idPrefix = `${baseId}-${entry.key}`;
          const error = blockError(errors, name, index);
          const blockName = label(entry, index);
          return (
            <li
              className="min-w-0"
              data-testid="knowledge-block"
              key={entry.key}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onDrop(event, index)}
            >
              <fieldset aria-describedby={error ? `${idPrefix}-error` : undefined} className="min-w-0 space-y-4 border-t border-sand pt-4">
                <legend className="flex w-full flex-wrap items-center gap-2 text-sm font-medium">
                  <span
                    aria-hidden="true"
                    className="cursor-grab select-none px-1 text-sage-text"
                    data-testid="knowledge-block-handle"
                    draggable
                    onDragEnd={() => {
                      dragging.current = null;
                    }}
                    onDragStart={(event) => {
                      dragging.current = index;
                      event.dataTransfer?.setData("text/plain", entry.key);
                    }}
                    title="Drag to reorder"
                  >
                    ⠿
                  </span>
                  {`Block ${index + 1}: ${blockTypeLabels[entry.draft.type]}`}
                </legend>
                <FieldError id={`${idPrefix}-error`} message={error} />
                <BlockFields
                  books={books}
                  draft={entry.draft}
                  entityId={entityId}
                  idPrefix={idPrefix}
                  ideas={ideas}
                  kind={kind}
                  onChange={(draft) => update(entry.key, draft)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    aria-label={`Move ${blockName} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    ref={(node: HTMLButtonElement | null) => {
                      controls.current.set(`${entry.key}:up`, node);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Move up
                  </Button>
                  <Button
                    aria-label={`Move ${blockName} down`}
                    disabled={index === entries.length - 1}
                    onClick={() => move(index, 1)}
                    ref={(node: HTMLButtonElement | null) => {
                      controls.current.set(`${entry.key}:down`, node);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Move down
                  </Button>
                  <Button aria-label={`Remove ${blockName}`} onClick={() => remove(index)} size="sm" type="button" variant="ghost">
                    Remove
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <p aria-live="polite" className="sr-only" data-testid="knowledge-block-announcement">
        {announcement}
      </p>
      <div className="grid min-w-0 gap-3 border-t border-sand pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`${baseId}-new-type`}>New block type</Label>
          <NativeSelect id={`${baseId}-new-type`} onChange={(event) => setNewType(event.target.value as BlockType)} value={newType}>
            {(Object.keys(blockTypeLabels) as BlockType[]).map((type) => (
              <option key={type} value={type}>
                {blockTypeLabels[type]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button onClick={add} type="button" variant="outline">
          Add block
        </Button>
      </div>
    </div>
  );
}
