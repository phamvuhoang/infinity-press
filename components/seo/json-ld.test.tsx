import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { JsonLd } from "@/components/seo/json-ld";

afterEach(cleanup);

it("renders escaped JSON-LD in a single script element", () => {
  const { container } = render(<JsonLd data={{ "@type": "Book", name: "A </script><b>bold</b> title" }} />);
  const scripts = container.querySelectorAll("script");
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toHaveAttribute("type", "application/ld+json");
  expect(scripts[0].innerHTML).not.toContain("<");
  expect(JSON.parse(scripts[0].textContent ?? "")).toEqual({ "@type": "Book", name: "A </script><b>bold</b> title" });
  expect(container.querySelector("b")).toBeNull();
});
