"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState } from "react";

import { createCoverUploadAction, finalizeCoverUploadAction } from "@/app/admin/books/[bookId]/cover-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import { COVER_MIME_TYPES, MAX_COVER_SIZE_BYTES } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/client";

async function imageSize(file: File): Promise<{ width: number | null; height: number | null }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

// Client checks make feedback immediate. The server action and database function enforce the same
// contract before an upload can reserve or attach a cover.
function validate(file: File): string | null {
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) return "Upload a JPEG, PNG, or WebP image.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_COVER_SIZE_BYTES) return "Cover images must be 5 MB or smaller.";
  return null;
}

export function CoverUploadForm({
  bookId,
  cover,
}: {
  bookId: string;
  cover: { publicUrl: string; altText: string } | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState(cover?.altText ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "saved"; text: string } | null>(null);

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    const validation = selected ? validate(selected) : null;
    setFile(selected);
    setMessage(validation ? { kind: "error", text: validation } : null);
  }

  async function upload() {
    if (!file) return;
    const validation = validate(file);
    if (validation) {
      setMessage({ kind: "error", text: validation });
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const reservation = await createCoverUploadAction(bookId, { fileName: file.name, mimeType: file.type, sizeBytes: file.size });
      if (!reservation.ok) {
        setMessage({ kind: "error", text: reservation.error });
        return;
      }

      const supabase = createClient();
      const [{ error: uploadError }, size] = await Promise.all([
        supabase.storage.from(COVERS_BUCKET).uploadToSignedUrl(reservation.path, reservation.token, file),
        imageSize(file),
      ]);
      if (uploadError) {
        setMessage({ kind: "error", text: "Upload to storage failed. You can retry." });
        return;
      }

      const finalized = await finalizeCoverUploadAction(bookId, { storageKey: reservation.storageKey, altText, ...size });
      if (!finalized.ok) {
        setMessage({ kind: "error", text: finalized.error });
        return;
      }

      setMessage({ kind: "saved", text: "Cover saved." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Something went wrong saving the cover. Try again." });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void upload();
  }

  return (
    <div className="grid min-w-0 gap-6 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="aspect-[2/3] w-32 overflow-hidden bg-surface">
        {cover ? (
          <Image alt={cover.altText} className="h-full w-full object-cover" height={192} src={cover.publicUrl} unoptimized width={128} />
        ) : (
          <p className="p-3 text-[0.75rem] text-sage-text">No cover yet</p>
        )}
      </div>
      <form className="min-w-0 space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="cover-file">Cover image</Label>
          <Input accept={COVER_MIME_TYPES.join(",")} disabled={busy} id="cover-file" onChange={onFileChange} type="file" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cover-alt">Cover alt text</Label>
          <Input disabled={busy} id="cover-alt" onChange={(event) => setAltText(event.target.value)} value={altText} />
        </div>
        <Button disabled={!file || busy || altText.trim() === "" || Boolean(file && validate(file))} type="submit">
          {busy ? "Uploading…" : "Upload cover"}
        </Button>
        {message ? (
          <p
            className={message.kind === "error" ? "text-[0.8125rem] text-error" : "text-[0.8125rem] text-success"}
            data-testid="cover-status"
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        ) : null}
      </form>
    </div>
  );
}
