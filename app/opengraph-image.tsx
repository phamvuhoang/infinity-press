import { ImageResponse } from "next/og";

import { SITE_NAME } from "@/lib/seo/metadata";

// The branded default share image (S5 spec 7.2). It uses the built-in font and no remote assets,
// so it renders at build time with nothing to fetch. Pages that name their own Open Graph images
// point here through DEFAULT_OG_IMAGE in lib/seo/metadata.ts.
export const alt = SITE_NAME;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          background: "#f7f4ed",
          color: "#202421",
        }}
      >
        <div style={{ display: "flex", width: 96, height: 6, background: "#34473e", marginBottom: 40 }} />
        <div style={{ display: "flex", fontSize: 112, letterSpacing: "-0.02em" }}>{SITE_NAME}</div>
        <div style={{ display: "flex", width: 480, height: 2, background: "#d8cbb9", marginTop: 48 }} />
      </div>
    ),
    size,
  );
}
