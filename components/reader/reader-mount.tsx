"use client";

import dynamic from "next/dynamic";

import type { ReaderClientProps } from "@/components/reader/reader-client";

// This wrapper exists for one reason: `ssr: false` is rejected inside a Server Component in this
// version of Next ("`ssr: false` is not allowed with `next/dynamic` in Server Components. Please
// move it into a Client Component" - node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md),
// so the reader page cannot make this call itself.
//
// Both halves of that option matter here:
//  - `dynamic` puts the reader, the engine adapter, and all of Readium into their own async chunk,
//    so no other route's bundle carries them.
//  - `ssr: false` keeps them off the server render entirely, which is required rather than merely
//    tidy: `EpubNavigator` builds its frame pool against real DOM APIs at construction time.
const ReaderClient = dynamic(
  () => import("@/components/reader/reader-client").then((module) => module.ReaderClient),
  { ssr: false },
);

export function ReaderMount(props: ReaderClientProps) {
  return <ReaderClient {...props} />;
}
