import type { Metadata } from "next";

// Keeps these private pages out of search results (S5 spec 7.2). Metadata only: this layout is not
// an authorization boundary. Every page and action here authorizes itself.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function PrivateLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
