import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import NotFound from "@/app/admin/not-found";

afterEach(cleanup);

describe("Admin NotFound", () => {
  // not-found.tsx receives no props from Next. This is a plain server component with no params
  // and no request-time API to read, so it has nothing that could throw when Next renders it bare.
  it("renders without throwing when called with no arguments", () => {
    expect(() => render(<NotFound />)).not.toThrow();
    expect(screen.getByText("Page not found")).toBeInTheDocument();
  });
});
