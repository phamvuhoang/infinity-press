"use client";

import { type ChangeEvent, useState } from "react";

import { createEpubUploadAction, finalizeEpubUploadAction } from "@/app/admin/books/[bookId]/epub/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
// Shared with lib/epub/upload.ts (which this Client Component cannot import - it is "server-
// only") so the client-side convenience ceiling and the server-side boundary ceiling cannot
// silently drift apart.
import { EPUB_MIME_TYPE, MAX_EPUB_SIZE_BYTES } from "@/lib/epub/constants";
import { createClient } from "@/lib/supabase/client";

const EBOOK_SOURCE_BUCKET = "ebook-source";

type Phase = "idle" | "reserving" | "uploading" | "finalizing" | "queued" | "error";

// Client-side validation is a convenience only - createEpubUpload() (lib/epub/upload.ts) is the
// boundary that actually rejects a bad upload. This exists so an admin sees the problem before
// spending a round trip on it, not instead of the server check.
function validateFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".epub")) {
    return "Choose a file with a .epub extension.";
  }
  if (file.type !== EPUB_MIME_TYPE) {
    return `File must be ${EPUB_MIME_TYPE}${file.type ? `, not ${file.type}` : ""}.`;
  }
  if (file.size === 0) {
    return "The selected file is empty.";
  }
  if (file.size > MAX_EPUB_SIZE_BYTES) {
    return "File exceeds the 100 MiB limit.";
  }
  return null;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const phaseLabel: Record<Exclude<Phase, "idle" | "error">, string> = {
  reserving: "Reserving…",
  uploading: "Uploading…",
  finalizing: "Finalizing…",
  queued: "Queued",
};

// The reservation/reserve-upload/finalize flow this drives: the Server Action reserves an asset
// and a signed upload target, the browser PUTs bytes to storage directly (the server never
// touches them), then a second Server Action call finalizes the asset and queues the processing
// job. Retrying after any failure just re-runs the whole thing from a fresh reservation - safe
// because admin_reserve_ebook_asset always allocates the next version rather than reusing one,
// and admin_finalize_ebook_asset rejects a second finalize of an asset that already succeeded
// instead of double-queuing a job.
export function EpubUploadForm({ bookId }: { bookId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setJobId(null);
    setAssetId(null);
    setErrorMessage(null);
    setPhase("idle");
    setValidationError(selected ? validateFile(selected) : null);
  }

  async function attemptUpload() {
    if (!file) return;
    const clientError = validateFile(file);
    if (clientError) {
      setValidationError(clientError);
      return;
    }

    setErrorMessage(null);
    setPhase("reserving");

    const reservation = await createEpubUploadAction(bookId, {
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    });
    if (!reservation.ok) {
      setPhase("error");
      setErrorMessage(reservation.error);
      return;
    }

    setPhase("uploading");
    try {
      const supabase = createClient();
      const [{ error: uploadError }, checksum] = await Promise.all([
        supabase.storage
          .from(EBOOK_SOURCE_BUCKET)
          .uploadToSignedUrl(reservation.signedUpload.path, reservation.signedUpload.token, file),
        sha256Hex(file),
      ]);
      if (uploadError) {
        setPhase("error");
        setErrorMessage("Upload to storage failed. You can retry.");
        return;
      }

      setPhase("finalizing");
      const finalized = await finalizeEpubUploadAction(bookId, reservation.assetId, checksum);
      if (!finalized.ok) {
        setPhase("error");
        setErrorMessage(finalized.error);
        return;
      }

      setJobId(finalized.jobId);
      setAssetId(reservation.assetId);
      setPhase("queued");
    } catch {
      setPhase("error");
      setErrorMessage("Something went wrong uploading the file. You can retry.");
    }
  }

  const busy = phase === "reserving" || phase === "uploading" || phase === "finalizing";

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="epub-file">EPUB file</Label>
        <Input
          accept=".epub,application/epub+zip"
          disabled={busy}
          id="epub-file"
          onChange={handleFileChange}
          type="file"
        />
        {validationError ? (
          <p className="text-[0.8125rem] text-error" role="alert">
            {validationError}
          </p>
        ) : null}
      </div>

      <Button
        disabled={!file || Boolean(validationError) || busy}
        onClick={() => void attemptUpload()}
        type="button"
      >
        {busy ? phaseLabel[phase] : phase === "error" ? "Retry upload" : "Upload EPUB"}
      </Button>

      {phase === "queued" && jobId ? (
        <p className="border-l-2 border-forest bg-surface px-4 py-3 text-sm" role="status">
          Queued for processing. Job {jobId}.{" "}
          {assetId ? (
            <a className="font-medium text-forest underline decoration-sand underline-offset-4" href={`/admin/publications/${assetId}`}>
              View status
            </a>
          ) : null}
        </p>
      ) : null}

      {phase === "error" && errorMessage ? (
        <p className="text-[0.8125rem] text-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
