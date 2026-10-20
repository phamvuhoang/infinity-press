import { serializeJsonLd } from "@/lib/seo/json-ld";

// Renders structured data from lib/seo/json-ld builders. The serializer escapes `<`, which is the
// only reason dangerouslySetInnerHTML is safe here; never pass it raw JSON.stringify output.
export function JsonLd({ data }: { data: unknown }) {
  return <script dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} type="application/ld+json" />;
}
