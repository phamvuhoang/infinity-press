import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(process.cwd(), "components/reader/reader-shell.module.css"),
  "utf8",
);

function parsedRules() {
  const style = document.createElement("style");
  style.textContent = stylesheet;
  document.head.append(style);

  return Array.from(style.sheet?.cssRules ?? []);
}

function styleRule(rules: CSSRule[], selector: string) {
  const rule = rules.find(
    (candidate): candidate is CSSStyleRule =>
      candidate.type === CSSRule.STYLE_RULE &&
      (candidate as CSSStyleRule).selectorText === selector,
  );

  expect(rule, `CSS rule ${selector}`).toBeDefined();
  return rule!;
}

describe("reader shell layout contract", () => {
  it("keeps samples on one full-span desktop track and entitled readers on sidebar plus main tracks", () => {
    const rules = parsedRules();
    const sampleSpan = styleRule(rules, ".sampleShell, .sampleMain");
    const desktop = rules.find(
      (candidate): candidate is CSSMediaRule =>
        candidate.type === CSSRule.MEDIA_RULE &&
        (candidate as CSSMediaRule).conditionText === "(min-width: 1280px)",
    );

    expect(desktop, "desktop reader media query").toBeDefined();
    expect(sampleSpan.style.getPropertyValue("grid-column")).toBe("1 / -1");
    expect(
      styleRule(Array.from(desktop!.cssRules), ".sampleShell").style.getPropertyValue(
        "grid-template-columns",
      ),
    ).toBe("minmax(0, 1fr)");
    expect(
      styleRule(Array.from(desktop!.cssRules), ".entitledShell").style.getPropertyValue(
        "grid-template-columns",
      ),
    ).toBe("clamp(360px, 27vw, 420px) minmax(0, 1fr)");
  });
});
