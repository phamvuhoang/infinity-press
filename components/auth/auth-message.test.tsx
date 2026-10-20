import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AuthMessage } from "@/components/auth/auth-message";
import vi from "@/lib/i18n/dictionaries/vi.json";

const alerts = vi.authentication.alerts;

describe("AuthMessage", () => {
  it("renders a known error in the dictionary language", () => {
    const html = renderToStaticMarkup(<AuthMessage alerts={alerts} error="callback" />);

    expect(html).toContain('role="alert"');
    expect(html).toContain(alerts.errors.callback);
  });

  it("renders a known message as a status", () => {
    const html = renderToStaticMarkup(<AuthMessage alerts={alerts} message="check-email" />);

    expect(html).toContain('role="status"');
    expect(html).toContain(alerts.messages["check-email"]);
  });

  it.each(["unknown", "toString", "constructor"])("ignores the unknown code %s", (code) => {
    expect(renderToStaticMarkup(<AuthMessage alerts={alerts} error={code} message={code} />)).toBe("");
  });
});
