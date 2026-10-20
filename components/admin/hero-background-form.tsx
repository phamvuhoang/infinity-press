"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { type ChangeEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";

import { clearHeroAction, createHeroUploadAction, saveHeroAction } from "@/app/admin/merchandising/hero-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import { HERO_MAX_ZOOM, HERO_MIN_ZOOM, heroCropRect } from "@/lib/catalog/hero-crop";
import { COVER_MIME_TYPES, HERO_ASPECTS, HERO_TARGET_WIDTH, MAX_HERO_SIZE_BYTES } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/client";

type Variant = "desktop" | "mobile";
type Hero = { desktopUrl: string; mobileUrl: string; altText: string };

const variants: Variant[] = ["desktop", "mobile"];
const variantLabel: Record<Variant, string> = { desktop: "Desktop · 16:9", mobile: "Mobile · 4:5" };

// The same checks the server action and admin_set_home_hero apply, run here so feedback is immediate.
function validate(file: File): string | null {
  if (!(COVER_MIME_TYPES as readonly string[]).includes(file.type)) return "Upload a JPEG, PNG, or WebP image.";
  if (file.size === 0) return "The selected file is empty.";
  if (file.size > MAX_HERO_SIZE_BYTES) return "Hero images must be 8 MB or smaller.";
  return null;
}

// Crops one aspect out of the loaded bitmap and re-encodes it as WebP at the width that viewport
// actually needs, so the storefront never downloads pixels it will crop away.
async function renderVariant(
  source: ImageBitmap,
  variant: Variant,
  zoom: number,
  focal: { x: number; y: number },
): Promise<File> {
  const aspect = HERO_ASPECTS[variant];
  const rect = heroCropRect(source.width, source.height, aspect, zoom, focal.x, focal.y);
  const width = Math.min(HERO_TARGET_WIDTH[variant], Math.round(rect.width));
  const height = Math.round(width / aspect);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob) throw new Error("Could not encode the crop.");
  return new File([blob], `hero-${variant}.webp`, { type: "image/webp" });
}

export function HeroBackgroundForm({ hero }: { hero: Hero | null }) {
  const router = useRouter();
  const [source, setSource] = useState<ImageBitmap | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [focal, setFocal] = useState({ x: 0.5, y: 0.5 });
  const [altText, setAltText] = useState(hero?.altText ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "saved"; text: string } | null>(null);
  const canvasRefs = useRef<Record<Variant, HTMLCanvasElement | null>>({ desktop: null, mobile: null });

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Live preview: the same geometry the upload will use, drawn small.
  useEffect(() => {
    if (!source) return;
    for (const variant of variants) {
      const canvas = canvasRefs.current[variant];
      const context = canvas?.getContext("2d");
      if (!canvas || !context) continue;
      const rect = heroCropRect(source.width, source.height, HERO_ASPECTS[variant], zoom, focal.x, focal.y);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
    }
  }, [source, zoom, focal]);

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    const validation = validate(file);
    if (validation) {
      setMessage({ kind: "error", text: validation });
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setSource(bitmap);
      setPreviewUrl(URL.createObjectURL(file));
      setZoom(1);
      setFocal({ x: 0.5, y: 0.5 });
      setMessage(null);
    } catch {
      setMessage({ kind: "error", text: "That image could not be read." });
    }
  }

  // Dragging on the source picks the focal point both crops centre on.
  const moveFocal = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setFocal({
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    });
  }, []);

  async function upload() {
    if (!source) return;
    setBusy(true);
    setMessage(null);

    try {
      const supabase = createClient();
      const keys: Partial<Record<Variant, string>> = {};

      for (const variant of variants) {
        const file = await renderVariant(source, variant, zoom, focal);
        const reservation = await createHeroUploadAction({ variant, mimeType: file.type, sizeBytes: file.size });
        if (!reservation.ok) {
          setMessage({ kind: "error", text: reservation.error });
          return;
        }
        const { error } = await supabase.storage.from(COVERS_BUCKET).uploadToSignedUrl(reservation.path, reservation.token, file);
        if (error) {
          setMessage({ kind: "error", text: "Upload to storage failed. You can retry." });
          return;
        }
        keys[variant] = reservation.storageKey;
      }

      const saved = await saveHeroAction({ desktopKey: keys.desktop!, mobileKey: keys.mobile!, altText });
      if (!saved.ok) {
        setMessage({ kind: "error", text: saved.error });
        return;
      }

      setMessage({ kind: "saved", text: "Hero background saved." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Something went wrong saving the hero image. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    const result = await clearHeroAction();
    setBusy(false);
    setMessage(result.ok ? { kind: "saved", text: "Hero background removed." } : { kind: "error", text: result.error });
    if (result.ok) router.refresh();
  }

  return (
    <div className="space-y-6">
      {hero ? (
        <div className="flex flex-wrap items-start gap-4">
          <Image alt={hero.altText} className="h-24 w-auto bg-surface object-cover" height={96} src={hero.desktopUrl} unoptimized width={171} />
          <Image alt="" className="h-24 w-auto bg-surface object-cover" height={96} src={hero.mobileUrl} unoptimized width={77} />
          <Button disabled={busy} onClick={() => void remove()} type="button" variant="secondary">
            Remove
          </Button>
        </div>
      ) : (
        <p className="text-[0.8125rem] text-sage-text">No hero background yet. The home page falls back to the Sand ground.</p>
      )}

      <div className="space-y-2">
        <Label htmlFor="hero-file">Hero image</Label>
        <Input accept={COVER_MIME_TYPES.join(",")} disabled={busy} id="hero-file" onChange={(event) => void onFileChange(event)} type="file" />
      </div>

      {source && previewUrl ? (
        <div className="space-y-5">
          {/* Click or drag to set the point both crops stay centred on. */}
          <div
            className="relative max-w-[26rem] cursor-crosshair touch-none overflow-hidden bg-surface select-none"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              moveFocal(event);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) moveFocal(event);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not a catalog asset */}
            <img alt="" className="block w-full" draggable={false} src={previewUrl} />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-ivory bg-forest/60"
              style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
            />
          </div>

          <div className="max-w-[26rem] space-y-2">
            <Label htmlFor="hero-zoom">Zoom</Label>
            <input
              className="w-full"
              disabled={busy}
              id="hero-zoom"
              max={HERO_MAX_ZOOM}
              min={HERO_MIN_ZOOM}
              onChange={(event) => setZoom(Number(event.target.value))}
              step={0.05}
              type="range"
              value={zoom}
            />
          </div>

          <div className="flex flex-wrap gap-6">
            {variants.map((variant) => (
              <div key={variant} className="space-y-2">
                <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{variantLabel[variant]}</p>
                <canvas
                  className="bg-surface"
                  data-testid={`hero-preview-${variant}`}
                  height={variant === "desktop" ? 126 : 280}
                  ref={(node) => { canvasRefs.current[variant] = node; }}
                  width={variant === "desktop" ? 224 : 224}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="max-w-[26rem] space-y-2">
        <Label htmlFor="hero-alt">Alt text</Label>
        <Input disabled={busy} id="hero-alt" onChange={(event) => setAltText(event.target.value)} value={altText} />
      </div>

      <Button disabled={!source || busy || altText.trim() === ""} onClick={() => void upload()} type="button">
        {busy ? "Uploading…" : "Save hero background"}
      </Button>

      {message ? (
        <p
          className={message.kind === "error" ? "text-[0.8125rem] text-error" : "text-[0.8125rem] text-success"}
          data-testid="hero-status"
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
