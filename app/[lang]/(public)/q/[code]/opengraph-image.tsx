import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";

import { getBookCardById } from "@/lib/data/catalog";
import { getSharedQuote } from "@/lib/data/shared-quotes";
import { splitGraphemes } from "@/lib/reader/quote";
import { SITE_NAME } from "@/lib/seo/metadata";

// The card as a link preview. An image route is cached by default, so it is forced dynamic like
// the page: a removed card's preview must 404 at once too. Same palette as app/opengraph-image.tsx
// and the built-in font, so nothing is fetched. No cover: covers have no URL next/og can embed.
export const dynamic = "force-dynamic";
export const alt = SITE_NAME;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// The reader's question under the quote, cut so the preview stays legible.
const QUESTION_GRAPHEMES = 120;

export default async function Image({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const card = await getSharedQuote(code);
  const book = card ? await getBookCardById(card.locale, card.bookId) : null;
  if (!card || !book) notFound();
  const long = card.quote.length > 160 || card.question !== null;
  const questionUnits = card.question ? splitGraphemes(card.question) : [];
  const question = questionUnits.length > QUESTION_GRAPHEMES ? `${questionUnits.slice(0, QUESTION_GRAPHEMES).join("")}…` : card.question;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 96px",
          background: "#f7f4ed",
          color: "#202421",
        }}
      >
        <div style={{ display: "flex", width: 96, height: 6, background: "#34473e" }} />
        <div style={{ display: "flex", fontSize: long ? 40 : 56, lineHeight: 1.25, letterSpacing: "-0.01em" }}>
          {`“${card.quote}”`}
        </div>
        {question ? <div style={{ display: "flex", fontSize: 30, lineHeight: 1.3, color: "#4a4f47" }}>{question}</div> : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", fontSize: 32 }}>{`${book.title} - ${book.author.name}`}</div>
          <div style={{ display: "flex", fontSize: 24, color: "#6b6f66" }}>{SITE_NAME}</div>
        </div>
      </div>
    ),
    size,
  );
}
