"use client";

import { SettingsIcon } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  READER_LINE_HEIGHTS,
  READER_MAX_FONT_PX,
  READER_MIN_FONT_PX,
  fontScaleToPx,
  pxToFontScale,
} from "@/lib/reader/preferences";
import type { ReaderPreferences } from "@/lib/reader/types";

// Board 1k's reading settings. Every change applies immediately - there is no Save button, because
// the only way to judge a font size is to see it on the page you are reading.
//
// The panel is presentational: it reports a new ReaderPreferences and does not store anything
// itself. ReaderClient owns both halves of "apply to the engine" and "write to localStorage", so
// there is one place where a preference change happens.

export type ReaderSettingsCopy = {
  settings: string;
  settingsTitle: string;
  fontSize: string;
  decreaseFontSize: string;
  increaseFontSize: string;
  font: string;
  fonts: { publisher: string; serif: string; sans: string };
  lineHeight: string;
  lineHeights: { tight: string; normal: string; loose: string };
  width: string;
  widths: { narrow: string; medium: string; wide: string };
  theme: string;
  themes: { light: string; sepia: string; dark: string };
  close: string;
};

const groupLabel = "text-xs font-medium tracking-wide text-sage-text uppercase";
const optionBase =
  "min-h-11 flex-1 rounded-md border border-sand px-3 text-sm text-current transition-colors duration-150 ease-quiet hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current aria-checked:border-forest aria-checked:bg-forest aria-checked:text-ivory";

// A native radiogroup rather than a listbox: these are small, mutually exclusive sets, and arrow-key
// navigation between them is what a screen-reader user expects. `role="radio"` with aria-checked is
// used instead of <input type="radio"> so the whole control is one styled target of at least 44px.
//
// The label id comes from useId(), not from the label text: aria-labelledby is a whitespace-tokenized
// ID *list*, so a text-derived id like "reader-setting-Line spacing" resolves to two ids ("reader-setting-Line"
// and "spacing") and silently fails to name the group. useId() also sidesteps collisions between two
// panels mounted at once, which a text-derived id would not.
//
// Roving tabindex per the WAI-ARIA APG radiogroup pattern: only the checked option is a tab stop, so
// the whole group is one stop in the page's tab order. Arrow keys move AND select in one action, and
// wrap at both ends.
function OptionGroup<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onSelect: (value: T) => void;
}) {
  const labelId = useId();
  const optionRefs = useRef(new Map<T, HTMLButtonElement>());

  function selectAndFocus(nextValue: T) {
    onSelect(nextValue);
    optionRefs.current.get(nextValue)?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = options.findIndex((option) => option.value === value);
    if (currentIndex === -1) return;

    let nextIndex: number;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % options.length;
    } else {
      return;
    }

    event.preventDefault();
    selectAndFocus(options[nextIndex].value);
  }

  return (
    <div className="space-y-2">
      <p className={groupLabel} id={labelId}>
        {label}
      </p>
      <div aria-labelledby={labelId} className="flex gap-2" onKeyDown={handleKeyDown} role="radiogroup">
        {options.map((option) => (
          <button
            aria-checked={option.value === value}
            className={optionBase}
            key={option.value}
            onClick={() => selectAndFocus(option.value)}
            ref={(node) => {
              if (node) optionRefs.current.set(option.value, node);
              else optionRefs.current.delete(option.value);
            }}
            role="radio"
            tabIndex={option.value === value ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReaderSettingsPanel({
  preferences,
  onChange,
  copy,
  open: controlledOpen,
  onOpenChange,
  triggerClassName,
  panelClassName,
}: {
  preferences: ReaderPreferences;
  onChange: (preferences: ReaderPreferences) => void;
  copy: ReaderSettingsCopy;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerClassName?: string;
  panelClassName?: string;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const fontPx = fontScaleToPx(preferences.fontScale);

  // Clamped at both ends, and the control is disabled at the boundary rather than silently doing
  // nothing: a button that looks live and is not reads as a broken reader.
  function stepFont(delta: number) {
    const next = fontPx + delta;
    if (next < READER_MIN_FONT_PX || next > READER_MAX_FONT_PX) return;
    onChange({ ...preferences, fontScale: pxToFontScale(next) });
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        aria-label={copy.settings}
        className={`inline-flex size-11 items-center justify-center rounded-md text-current outline-none transition-colors duration-150 ease-quiet hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current ${triggerClassName ?? ""}`}
      >
        <SettingsIcon aria-hidden="true" className="size-5" />
      </DialogTrigger>

      <DialogPanel className={panelClassName} side="right">
        <div className="flex items-center justify-between gap-4">
          <DialogTitle>{copy.settingsTitle}</DialogTitle>
          <DialogClose>{copy.close}</DialogClose>
        </div>

        <div className="space-y-2">
          <p className={groupLabel}>{copy.fontSize}</p>
          <div className="flex items-center gap-2">
            <button
              aria-label={copy.decreaseFontSize}
              className={`${optionBase} flex-none px-4`}
              disabled={fontPx <= READER_MIN_FONT_PX}
              onClick={() => stepFont(-1)}
              type="button"
            >
              A−
            </button>
            <span className="min-w-14 text-center text-sm tabular-nums">{fontPx}px</span>
            <button
              aria-label={copy.increaseFontSize}
              className={`${optionBase} flex-none px-4`}
              disabled={fontPx >= READER_MAX_FONT_PX}
              onClick={() => stepFont(1)}
              type="button"
            >
              A+
            </button>
          </div>
        </div>

        <OptionGroup
          label={copy.font}
          onSelect={(fontFamily) => onChange({ ...preferences, fontFamily })}
          options={[
            { value: "publisher" as const, label: copy.fonts.publisher },
            { value: "serif" as const, label: copy.fonts.serif },
            { value: "sans" as const, label: copy.fonts.sans },
          ]}
          value={preferences.fontFamily}
        />

        <OptionGroup
          label={copy.lineHeight}
          onSelect={(value) => onChange({ ...preferences, lineHeight: Number(value) })}
          options={[
            { value: String(READER_LINE_HEIGHTS[0]), label: copy.lineHeights.tight },
            { value: String(READER_LINE_HEIGHTS[1]), label: copy.lineHeights.normal },
            { value: String(READER_LINE_HEIGHTS[2]), label: copy.lineHeights.loose },
          ]}
          value={String(preferences.lineHeight)}
        />

        <OptionGroup
          label={copy.width}
          onSelect={(width) => onChange({ ...preferences, width })}
          options={[
            { value: "narrow" as const, label: copy.widths.narrow },
            { value: "medium" as const, label: copy.widths.medium },
            { value: "wide" as const, label: copy.widths.wide },
          ]}
          value={preferences.width}
        />

        <OptionGroup
          label={copy.theme}
          onSelect={(theme) => onChange({ ...preferences, theme })}
          options={[
            { value: "light" as const, label: copy.themes.light },
            { value: "sepia" as const, label: copy.themes.sepia },
            { value: "dark" as const, label: copy.themes.dark },
          ]}
          value={preferences.theme}
        />
      </DialogPanel>
    </Dialog>
  );
}
