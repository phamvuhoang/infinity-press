import { CHAPTER_ONE_HREF, CHAPTER_THREE_HREF, CHAPTER_TWO_HREF } from "./publication";
import { createServiceRoleClient } from "./supabase";

// A published S20 journey with one session per fixture chapter, written straight through the
// service role (e2e/admin-journeys.spec.ts covers the admin path). vi and en text, so the journey
// shows on both interfaces. Local stack only.
export async function seedPublishedJourney(options: {
  bookId: string;
  editionId: string;
  slug: string;
}): Promise<{ journeyId: string }> {
  const service = createServiceRoleClient();
  const { data: journey, error } = await service
    .from("reading_journeys")
    .insert({ book_id: options.bookId, edition_id: options.editionId, slug: options.slug, status: "published" })
    .select("id")
    .single();
  if (error) throw error;

  const check = (result: { error: unknown }) => {
    if (result.error) throw result.error;
  };
  check(
    await service.from("journey_localizations").insert([
      { journey_id: journey.id, locale: "vi", title: "Ba ngày đọc", summary: "Mỗi ngày một chương." },
      { journey_id: journey.id, locale: "en", title: "Three days of reading", summary: "One chapter a day." },
    ]),
  );

  // The second start carries a fragment, as an admin's pick from a real EPUB nav usually does: the
  // session page must still resolve it to the chapter's passage.
  const hrefs = [CHAPTER_ONE_HREF, `${CHAPTER_TWO_HREF}#section`, CHAPTER_THREE_HREF];
  const { data: sessions, error: sessionError } = await service
    .from("journey_sessions")
    .insert(
      hrefs.map((href, index) => ({
        journey_id: journey.id,
        position: index + 1,
        start_locator: { href, progression: 0, totalProgression: null, locations: {} },
      })),
    )
    .select("id, position");
  if (sessionError) throw sessionError;

  check(
    await service.from("journey_session_localizations").insert(
      sessions.flatMap((session) => [
        { session_id: session.id, locale: "vi", title: `Ngày ${session.position}`, guide_md: "Đọc chậm.", questions: ["Điều gì đọng lại?"] },
        { session_id: session.id, locale: "en", title: `Day ${session.position}`, guide_md: "Read slowly.", questions: ["What stayed with you?"] },
      ]),
    ),
  );
  return { journeyId: journey.id };
}
