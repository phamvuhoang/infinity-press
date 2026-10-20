import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import NotFound from "@/app/[lang]/not-found";

// not-found.tsx receives no props from Next - not even params - and no longer reads the request
// either (Ruling 12, task-5-report.md): a not-found or forbidden boundary that depends on
// headers() is enough on its own to stop the whole /[lang] segment from prerendering with concrete
// params. It always renders the default locale's copy now, which is why there is no "other locale"
// case left to test here - see app/[lang]/layout.tsx for the same tradeoff made the same way.
afterEach(cleanup);

describe("NotFound", () => {
  it("renders without throwing when Next gives it no props at all", () => {
    expect(() => render(NotFound())).not.toThrow();
  });

  it("renders the default locale's copy", () => {
    render(NotFound());

    expect(screen.getByText("Page not found")).toBeInTheDocument();
  });
});
