"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useState } from "react";

import { createAuthorImageUploadAction, finalizeAuthorImageUploadAction } from "@/app/admin/entities/author-image-actions";
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

// The same contract the server action and admin_set_author_image enforce, checked here so feedback
// is immediate.
function validate(file: File): string | null {
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) return "Upload a JPEG, PNG, or WebP image.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_COVER_SIZE_BYTES) return "Portraits must be 5 MB or smaller.";
  return null;
}

export function AuthorImageForm({
  authorId,
  image,
}: {
  authorId: string;
  image: { publicUrl: string; altText: string } | null;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [altText, setAltText] = useState(image?.altText ?? "");
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
      const reservation = await createAuthorImageUploadAction(authorId, { mimeType: file.type, sizeBytes: file.size });
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

      const finalized = await finalizeAuthorImageUploadAction(authorId, { storageKey: reservation.storageKey, altText, ...size });
      if (!finalized.ok) {
        setMessage({ kind: "error", text: finalized.error });
        return;
      }

      setMessage({ kind: "saved", text: "Portrait saved." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Something went wrong saving the portrait. Try again." });
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void upload();
  }

  return (
    <div className="grid min-w-0 gap-6 sm:grid-cols-[10rem_minmax(0,1fr)]">
      {/* Board 1e crops the portrait to 4:5, so the preview uses the same box. */}
      <div className="aspect-[4/5] w-40 overflow-hidden bg-surface">
        {image ? (
          <Image alt={image.altText} className="h-full w-full object-cover" height={200} src={image.publicUrl} unoptimized width={160} />
        ) : (
          <p className="p-3 text-[0.75rem] text-sage-text">No portrait yet</p>
        )}
      </div>
      <form className="min-w-0 space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="author-image-file">Portrait</Label>
          <Input accept={COVER_MIME_TYPES.join(",")} disabled={busy} id="author-image-file" onChange={onFileChange} type="file" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="author-image-alt">Portrait alt text</Label>
          <Input disabled={busy} id="author-image-alt" onChange={(event) => setAltText(event.target.value)} value={altText} />
        </div>
        <Button disabled={!file || busy || altText.trim() === "" || Boolean(file && validate(file))} type="submit">
          {busy ? "Uploading…" : "Upload portrait"}
        </Button>
        {message ? (
          <p
            className={message.kind === "error" ? "text-[0.8125rem] text-error" : "text-[0.8125rem] text-success"}
            data-testid="author-image-status"
            role={message.kind === "error" ? "alert" : "status"}
          >
            {message.text}
          </p>
        ) : null}
      </form>
    </div>
  );
}
