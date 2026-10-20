import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import NotFound from "@/app/internal/[lang]/not-found";

afterEach(cleanup);

describe("Internal NotFound", () => {
  // not-found.tsx receives no props from Next, even under a [lang] segment. /internal is
  // English-only by convention, so this is a plain server component with no params to read.
  it("renders without throwing when called with no arguments", () => {
    expect(() => render(<NotFound />)).not.toThrow();
    expect(screen.getByText("Page not found")).toBeInTheDocument();
  });
});
