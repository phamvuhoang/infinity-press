"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";

import { deleteSessionAction, saveSessionAction, saveSessionLocalizationAction } from "@/app/admin/journeys/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState } from "@/lib/catalog/form";
import type { AdminJourneySessionDTO } from "@/lib/data/admin-journeys";
import type { Locale } from "@/lib/i18n/config";

type TocOption = { href: string; title: string };

// A session's range is two hrefs from the active publication's toc. A stored href the toc no longer
// lists stays selectable, so re-saving a session never silently moves it.
function HrefSelect({ id, name, label, value, tocHrefs, optional }: { id: string; name: string; label: string; value: string; tocHrefs: TocOption[]; optional?: boolean }) {
  const missing = value !== "" && !tocHrefs.some((entry) => entry.href === value);
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect defaultValue={value} id={id} name={name} required={!optional}>
        <option value="">{optional ? "End of the start chapter" : "Choose a chapter"}</option>
        {missing ? <option value={value}>{`Not in contents: ${value}`}</option> : null}
        {tocHrefs.map((entry) => (
          <option key={entry.href} value={entry.href}>
            {entry.title}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function SessionRangeForm({ journeyId, session, position, tocHrefs }: { journeyId: string; session: AdminJourneySessionDTO | null; position: number; tocHrefs: TocOption[] }) {
  const [state, formAction] = useActionState(saveSessionAction.bind(null, journeyId), initialAdminFormState);
  const prefix = session ? `session-${session.id}` : "session-new";
  return (
    <form action={formAction} aria-label={session ? `Session ${position} range` : "Add session"} className="min-w-0 space-y-4" onReset={(event) => event.preventDefault()}>
      {session ? (
        <input name="position" type="hidden" value={position} />
      ) : (
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`${prefix}-position`}>Position</Label>
          <Input defaultValue={position} id={`${prefix}-position`} max={60} min={1} name="position" required type="number" />
          <FieldError message={state.fieldErrors.position} />
        </div>
      )}
      <HrefSelect id={`${prefix}-start`} label="Start" name="startHref" tocHrefs={tocHrefs} value={session?.startHref ?? ""} />
      <FieldError message={state.fieldErrors.startHref} />
      <HrefSelect id={`${prefix}-end`} label="End" name="endHref" optional tocHrefs={tocHrefs} value={session?.endHref ?? ""} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel="Saving…">
        {session ? "Save range" : "Add session"}
      </SubmitButton>
    </form>
  );
}

function SessionLocalizationForm({ journeyId, session, locale }: { journeyId: string; session: AdminJourneySessionDTO; locale: Locale }) {
  const [state, formAction] = useActionState(saveSessionLocalizationAction.bind(null, journeyId, session.id, locale), initialAdminFormState);
  const localization = session.localizations.find((value) => value.locale === locale);
  const id = (field: string) => `session-${session.id}-${locale}-${field}`;
  return (
    <form action={formAction} aria-label={`Session ${session.position} ${locale}`} className="min-w-0 space-y-4" onReset={(event) => event.preventDefault()}>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={id("title")}>{`Title (${locale})`}</Label>
        <Input defaultValue={localization?.title ?? ""} id={id("title")} name="title" required />
        <FieldError message={state.fieldErrors.title} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={id("guide")}>{`Guide (${locale})`}</Label>
        <Textarea defaultValue={localization?.guideMd ?? ""} id={id("guide")} name="guideMd" rows={4} />
        <FieldError message={state.fieldErrors.guideMd} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={id("questions")}>{`Questions (${locale}), one per line, at most three`}</Label>
        <Textarea defaultValue={localization?.questions.join("\n") ?? ""} id={id("questions")} name="questions" rows={3} />
        <FieldError message={state.fieldErrors.questions} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel="Saving…">{`Save ${locale} session text`}</SubmitButton>
    </form>
  );
}

function DeleteSessionButton({ journeyId, session }: { journeyId: string; session: AdminJourneySessionDTO }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        disabled={isPending}
        onClick={() => {
          if (!window.confirm(`Delete session ${session.position}? Its text in every language is removed.`)) return;
          startTransition(async () => {
            const result = await deleteSessionAction(journeyId, session.id);
            if (result.ok) router.refresh();
            else setMessage(result.message);
          });
        }}
        type="button"
        variant="outline"
      >
        {`Delete session ${session.position}`}
      </Button>
      {message ? (
        <p className="text-[0.8125rem] text-error" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function SessionEditor({
  journeyId,
  sessions,
  tocHrefs,
  locales,
}: {
  journeyId: string;
  sessions: AdminJourneySessionDTO[];
  tocHrefs: TocOption[];
  locales: Locale[];
}) {
  const nextPosition = Math.max(0, ...sessions.map((session) => session.position)) + 1;
  return (
    <div className="min-w-0 space-y-10">
      {tocHrefs.length === 0 ? (
        <p className="border-l-2 border-error bg-surface px-4 py-3 text-sm text-error" role="alert">
          This edition has no active publication, so there is no table of contents to pick sessions from.
        </p>
      ) : null}
      <ol aria-label="Sessions" className="space-y-10">
        {sessions.map((session) => (
          <li aria-label={`Session ${session.position}`} className="min-w-0 space-y-6 border-l border-sand pl-4" key={session.id}>
            <h3 className="font-serif text-xl font-normal">{`Session ${session.position}`}</h3>
            <SessionRangeForm journeyId={journeyId} position={session.position} session={session} tocHrefs={tocHrefs} />
            {locales.map((locale) => (
              <SessionLocalizationForm journeyId={journeyId} key={locale} locale={locale} session={session} />
            ))}
            <DeleteSessionButton journeyId={journeyId} session={session} />
          </li>
        ))}
      </ol>
      <div className="min-w-0 space-y-4 border-t border-sand pt-6">
        <h3 className="font-serif text-xl font-normal">New session</h3>
        {/* Keyed by the next position so the default refreshes after each add. */}
        <SessionRangeForm journeyId={journeyId} key={nextPosition} position={nextPosition} session={null} tocHrefs={tocHrefs} />
      </div>
    </div>
  );
}
