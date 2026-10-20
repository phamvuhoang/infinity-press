// Shared between lib/epub/upload.ts (server-only) and components/admin/epub-upload-form.tsx (a
// Client Component, which cannot import a "server-only" module) so the client-side convenience
// check and the server-side boundary check cannot silently drift onto two different ceilings.
// This file itself must never import "server-only" or anything that does.
export const EPUB_MIME_TYPE = "application/epub+zip";
export const MAX_EPUB_SIZE_BYTES = 100 * 1024 * 1024;

// Bucket names for the two private storage buckets Task 3 created
// (20260911160000_ebook_storage.sql). Task 5's job-store.ts needs the derived-resource
// bucket name too, and lives outside any Next.js request context (a plain CLI process), so
// both names are collected here rather than only in lib/epub/upload.ts - this file is the
// one place in lib/epub guaranteed free of "server-only"/"next/headers" imports.
export const EBOOK_SOURCE_BUCKET = "ebook-source";
export const EBOOK_DERIVED_BUCKET = "ebook-derived";
