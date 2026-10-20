import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderSettingsPanel } from "@/components/reader/reader-settings-panel";
import { DEFAULT_READER_PREFERENCES } from "@/lib/reader/preferences";
import type { ReaderPreferences } from "@/lib/reader/types";

afterEach(cleanup);

const copy = {
  settings: "Reading settings",
  settingsTitle: "Reading settings",
  fontSize: "Font size",
  decreaseFontSize: "Smaller text",
  increaseFontSize: "Larger text",
  font: "Font",
  fonts: { publisher: "Publisher", serif: "Lora", sans: "Sans" },
  lineHeight: "Line spacing",
  lineHeights: { tight: "Tight", normal: "Normal", loose: "Loose" },
  width: "Text width",
  widths: { narrow: "Narrow", medium: "Medium", wide: "Wide" },
  theme: "Theme",
  themes: { light: "Light", sepia: "Paper", dark: "Dark" },
  close: "Close",
};

async function openPanel() {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<ReaderSettingsPanel copy={copy} onChange={onChange} preferences={DEFAULT_READER_PREFERENCES} />);
  await user.click(screen.getByRole("button", { name: "Reading settings" }));
  return { user, onChange };
}

// The panel is controlled, so proving that arrow keys move the *selection* (not just focus) needs a
// stateful caller feeding the new preferences back in - asserting against a fixed prop would only
// prove the prop did not change, the same trap the boundary tests avoid.
function ControlledPanel() {
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_READER_PREFERENCES);
  return <ReaderSettingsPanel copy={copy} onChange={setPreferences} preferences={preferences} />;
}

async function openControlledPanel() {
  const user = userEvent.setup();
  render(<ControlledPanel />);
  await user.click(screen.getByRole("button", { name: "Reading settings" }));
  return { user };
}

describe("ReaderSettingsPanel", () => {
  it("reports the current setting for each group", async () => {
    await openPanel();

    expect(screen.getByRole("radio", { name: "Publisher" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Paper" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Normal" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(screen.getByText("16px")).toBeInTheDocument();
  });

  it("raises the font size by one step", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("button", { name: "Larger text" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, fontScale: 17 / 16 });
  });

  it("lowers the font size by one step", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("button", { name: "Smaller text" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, fontScale: 15 / 16 });
  });

  // The panel is controlled: it renders whatever preferences it is given and never holds its own.
  // So the floor is tested by rendering AT the floor - clicking twice against a fixed prop would
  // only prove the prop did not change.
  it("disables the controls at each end of the offered range", async () => {
    const user = userEvent.setup();

    const { unmount } = render(
      <ReaderSettingsPanel
        copy={copy}
        onChange={vi.fn()}
        preferences={{ ...DEFAULT_READER_PREFERENCES, fontScale: 15 / 16 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    expect(screen.getByRole("button", { name: "Smaller text" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Larger text" })).toBeEnabled();
    unmount();

    render(
      <ReaderSettingsPanel
        copy={copy}
        onChange={vi.fn()}
        preferences={{ ...DEFAULT_READER_PREFERENCES, fontScale: 26 / 16 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    expect(screen.getByRole("button", { name: "Larger text" })).toBeDisabled();
  });

  it("changes the theme", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, theme: "dark" });
  });

  it("changes the reading-column width", async () => {
    const { user, onChange } = await openPanel();

    await user.click(screen.getByRole("radio", { name: "Wide" }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_READER_PREFERENCES, width: "wide" });
  });

  it("is operable by keyboard alone", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ReaderSettingsPanel copy={copy} onChange={onChange} preferences={DEFAULT_READER_PREFERENCES} />);

    await user.tab();
    expect(screen.getByRole("button", { name: "Reading settings" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "Reading settings" })).toBeInTheDocument();
  });

  // aria-labelledby is a whitespace-tokenized id list. A multi-word label proves the group's name
  // isn't produced by an id scheme that happens to work only for single-word labels.
  it("names each radiogroup with its full label, including multi-word labels", async () => {
    await openPanel();

    expect(screen.getByRole("radiogroup", { name: "Line spacing" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Text width" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Font" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
  });

  it("moves the selection with arrow keys and wraps at both ends", async () => {
    const { user } = await openControlledPanel();

    const light = screen.getByRole("radio", { name: "Light" });
    await user.click(light);

    // Light is first in the group; ArrowLeft wraps to the last option, Dark.
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();

    // ArrowRight from the last option wraps back to the first, Light.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Paper" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Paper" })).toHaveFocus();
  });

  it("keeps each radiogroup as a single tab stop", async () => {
    const { user } = await openControlledPanel();

    // Publisher (font group) is checked by default, so it is the group's one tab stop; Lora and Sans
    // carry tabIndex=-1 and must not receive focus via Tab.
    screen.getByRole("radio", { name: "Publisher" }).focus();
    await user.tab();

    // The next stop is the line-height group's checked option (Normal, the default), not an
    // unchecked option within the font group.
    expect(screen.getByRole("radio", { name: "Normal" })).toHaveFocus();
  });
});
