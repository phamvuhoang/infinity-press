import { type APIRequestContext, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { createKnowledgeAdmin, seedPublishedIdea, signInKnowledgeAdmin } from "./support/knowledge";
import { grantEntitlement } from "./support/publication";
import { serverEnvironmentValue } from "./support/server-env";
import { openSqlSession } from "./support/sql-session";
import { createAnonClient, createServiceRoleClient } from "./support/supabase";

// S13 acceptance (spec 10, 11). Two journeys: an owner's review goes through moderation and an
// author reply onto the book page and into its Book JSON-LD; a reader's question from an idea page
// is answered with a new idea, and publishing that idea delivers exactly one question_answered email
// and puts the answer link on the reader's ask page.
//
// Mail goes through the no-network adapter (EMAIL_PROVIDER=test in playwright.config.ts), as in
// every other spec: no SMTP path exists, so nothing reaches Mailpit. The email is asserted where it
// is observable - the outbox row the worker completed, with the provider id the adapter returns.
// The link the message carries is built by lib/email/outbox.ts from the same localization the ask
// page links to (covered by lib/email/outbox.test.ts); here that URL is checked to resolve.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OPS_WORKER_SECRET = serverEnvironmentValue("OPS_WORKER_SECRET");

function check<T>(result: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (result.error) throw new Error(result.error.message);
  return result.data as NonNullable<T>;
}

// The scheduled worker, called the way pg_net calls it: a body-less POST carrying only the secret.
async function runOperationsWorker(request: APIRequestContext): Promise<void> {
  const response = await request.post("/api/operations/run", {
    headers: { authorization: `Bearer ${OPS_WORKER_SECRET}` },
  });
  expect(response.status()).toBe(200);
}

test("an owner reviews, an admin replies and publishes, and the book page shows both with aggregateRating", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `review-${suffix}`;
  const title = `Review ${suffix}`;
  const body = `Cuốn sách rất hay ${suffix}.`;
  const reply = `Cảm ơn bạn đã đọc ${suffix}.`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug, title } } });
  const reader = await createReader("reviewer");
  await grantEntitlement(bookId, reader.email);

  await signInAs(page, reader.email, `/vi/library/reviews/${bookId}`);
  // The radio is visually hidden behind its star; a reader clicks the star, i.e. the label.
  const fiveStars = page.getByLabel("5/5");
  await page.locator("label").filter({ has: fiveStars }).click();
  await expect(fiveStars).toBeChecked();
  await page.getByLabel("Nhận xét").fill(body);
  await page.getByRole("button", { name: "Lưu đánh giá" }).click();
  await expect(page.getByText("Đang chờ duyệt", { exact: true })).toBeVisible();

  const admin = await createReader("review-admin", { admin: true });
  await signInAs(page, admin.email, "/admin/reviews");
  const row = page.getByRole("row", { name: new RegExp(title) });
  // Reply first, while the review is still in the Pending tab; publishing moves it out of this list.
  await row.getByRole("button", { name: "Reply", exact: true }).click();
  await row.getByLabel("Reply", { exact: true }).fill(reply);
  await row.getByRole("button", { name: "Save reply" }).click();
  await expect(row.getByRole("status")).toHaveText("Saved.");
  await row.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(row).toHaveCount(0);

  // S15: publishing a review that already carries a reply queues one review_replied row, and the
  // worker delivers it. The reply was saved while pending, so nothing was queued before publish.
  const service = createServiceRoleClient();
  const reviewRows = check(
    await service.from("book_reviews").select("id").eq("book_id", bookId).eq("profile_id", reader.profileId),
  ) as { id: string }[];
  const outboxFor = async () =>
    check(
      await service
        .from("notification_outbox")
        .select("id, template_key, sent_at, provider_message_id, last_error_code")
        .eq("review_id", reviewRows[0].id),
    ) as { id: string; template_key: string; sent_at: string | null; provider_message_id: string | null; last_error_code: string | null }[];
  const [queued] = await outboxFor();
  expect(queued).toMatchObject({ template_key: "review_replied", sent_at: null });
  await expect
    .poll(
      async () => {
        await runOperationsWorker(request);
        return (await outboxFor())[0].sent_at;
      },
      { message: "the review_replied row is delivered", timeout: 60_000, intervals: [500] },
    )
    .not.toBeNull();
  const delivered = await outboxFor();
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ provider_message_id: `test/review-replied/${queued.id}`, last_error_code: null });

  // The admin list now shows the delivery on the published tab.
  await page.goto("/admin/reviews?status=published");
  await expect(page.getByRole("row", { name: new RegExp(title) }).getByText(/^Emailed /)).toBeVisible();

  // The moderation action revalidates the storefront itself; a brand-new slug renders on demand.
  await page.goto(`/vi/books/${slug}`);
  const reviews = page.getByRole("region", { name: "Đánh giá từ độc giả" });
  await expect(reviews.getByText(body)).toBeVisible();
  await expect(reviews.getByText(reply)).toBeVisible();

  const nodes = (await page.locator('script[type="application/ld+json"]').allTextContents()).flatMap(
    (script) => [JSON.parse(script)].flat() as Record<string, unknown>[],
  );
  const book = nodes.find((node) => node["@type"] === "Book");
  expect(book?.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 5, reviewCount: 1, bestRating: 5, worstRating: 1 });
  expect(book?.review).toEqual([
    expect.objectContaining({ "@type": "Review", reviewBody: body, reviewRating: expect.objectContaining({ ratingValue: 5 }) }),
  ]);

  // Raw review rows must not expose profile IDs through PostgREST.
  const publicRows = await createAnonClient().from("book_reviews").select("profile_id, locale");
  expect(publicRows.error?.code).toBe("42501");

  // Revocation removes editing rights, not the reader's control over their existing review.
  check(await service.from("entitlements").update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("book_id", bookId).eq("profile_id", reader.profileId));
  await signInAs(page, reader.email, `/vi/library/reviews/${bookId}`);
  await expect(page.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu đánh giá" })).toHaveCount(0);
  await page.getByRole("button", { name: "Xoá đánh giá" }).click();
  await expect(page).toHaveURL(/\/vi\/library$/);
  expect(check(await service.from("book_reviews").select("id").eq("book_id", bookId).eq("profile_id", reader.profileId))).toEqual([]);
});

test("a reader asks from an idea, the admin answers with a new idea, and publishing it emails the asker once", async ({ page, request }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `ask-${suffix}`, title: `Ask ${suffix}` } } });
  const admin = await createKnowledgeAdmin("ask-admin");
  const ideaSlug = `doc-cham-goc-${suffix}`;
  const { ideaId } = await seedPublishedIdea(await signInKnowledgeAdmin(admin), {
    locale: "vi",
    slug: ideaSlug,
    question: `Vì sao nên đọc chậm ${suffix}?`,
    shortAnswer: `Vì chậm lại giúp nhớ lâu ${suffix}.`,
    body: `Thân bài ${suffix}.`,
    bookIds: [bookId],
  });
  const reader = await createReader("asker");
  const askBody = `Làm sao để đọc chậm hơn ${suffix}?`;

  await signInAs(page, reader.email, `/vi/ideas/${ideaSlug}`);
  await page.getByRole("link", { name: "Hỏi ban biên tập về điều này" }).click();
  await expect(page).toHaveURL(new RegExp(`/vi/ask\\?idea=${ideaId}$`));
  await page.getByLabel("Câu hỏi của bạn").fill(askBody);
  await page.getByRole("button", { name: "Gửi câu hỏi" }).click();
  const mine = page.getByRole("listitem").filter({ hasText: askBody });
  await expect(mine.getByText("Đang chờ", { exact: true })).toBeVisible();

  const service = createServiceRoleClient();
  const question = check(
    await service.from("reader_questions").select("id").eq("profile_id", reader.profileId).single(),
  ) as { id: string };

  // The editor rewrites the reader's wording into the idea's question, so the published page
  // carries nothing the asker typed.
  const answerSlug = `doc-cham-${suffix}`;
  const answerQuestion = `Đọc chậm bắt đầu từ đâu ${suffix}?`;
  const answerShort = `Đọc từng đoạn và dừng lại ${suffix}.`;
  await signInAs(page, admin.email, "/admin/questions");
  const row = page.getByRole("row", { name: new RegExp(askBody.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  await row.getByRole("button", { name: "Answer with a new idea" }).click();
  await expect(row.getByLabel("Locale")).toHaveValue("vi");
  await row.getByLabel("Slug").fill(answerSlug);
  await row.getByLabel("Question").fill(answerQuestion);
  await row.getByLabel("Short answer").fill(answerShort);
  await row.getByRole("button", { name: "Create idea" }).click();
  await expect(page).toHaveURL(/\/admin\/ideas\/[0-9a-f-]{36}$/);

  // Linking marks the question answered but queues nothing: a draft URL would 404.
  const outboxFor = async () =>
    check(
      await service
        .from("notification_outbox")
        .select("id, template_key, sent_at, provider_message_id, last_error_code")
        .eq("question_id", question.id),
    ) as { id: string; template_key: string; sent_at: string | null; provider_message_id: string | null; last_error_code: string | null }[];
  expect(await outboxFor()).toEqual([]);

  // publish_idea's readiness wants one content block; the answer RPC already related the asked
  // idea's book.
  const content = page.locator("form").filter({ has: page.getByRole("button", { name: "Save vi content" }) });
  await content.getByLabel("New block type").selectOption("paragraph");
  await content.getByRole("button", { name: "Add block" }).click();
  await content.getByLabel("Text", { exact: true }).fill(`Một đoạn đọc mỗi lần ${suffix}.`);
  await content.getByRole("button", { name: "Save vi content" }).click();
  await expect(content.getByTestId("form-saved")).toHaveCount(1);
  const publish = page.getByRole("button", { name: "Publish idea" });
  await expect(publish).toBeEnabled();
  page.once("dialog", (dialog) => void dialog.accept());
  await publish.click();
  await expect(page.getByTestId("knowledge-publish-message")).toHaveText("Idea published.");

  // Exactly one outbox row, delivered by the worker. Other specs' rows may be ahead of it in the
  // 25-row claim, so the worker runs until this one goes out.
  const [queued] = await outboxFor();
  expect(queued).toMatchObject({ template_key: "question_answered", sent_at: null });
  await expect
    .poll(
      async () => {
        await runOperationsWorker(request);
        return (await outboxFor())[0].sent_at;
      },
      { message: "the question_answered row is delivered", timeout: 60_000, intervals: [500] },
    )
    .not.toBeNull();
  const delivered = await outboxFor();
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({ provider_message_id: `test/question-answered/${queued.id}`, last_error_code: null });

  // The asker's page links the published answer in the locale they asked in.
  await signInAs(page, reader.email, `/vi/ask?idea=${ideaId}`);
  const answered = page.getByRole("listitem").filter({ hasText: askBody });
  await expect(answered.getByText("Đã trả lời", { exact: true })).toBeVisible();
  await expect(answered.getByRole("link", { name: "Đọc câu trả lời" })).toHaveAttribute("href", `/vi/ideas/${answerSlug}`);

  // The answer resolves, and its public HTML carries no asker data.
  const answerPage = await request.get(`/vi/ideas/${answerSlug}`);
  expect(answerPage.status()).toBe(200);
  const html = await answerPage.text();
  expect(html).toContain(answerShort);
  expect(html).not.toContain(askBody);
  expect(html).not.toContain(reader.email);
  expect(html).not.toContain(reader.profileId);
});

// Hold the first transaction after its write, then let the second attempt the competing write.
// Both interleavings used to commit successfully with no notification at all.
for (const first of ["publish", "link"] as const) {
  test(`concurrent answer linking and publication queue one email (${first} first)`, async () => {
    const suffix = unique();
    const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `race-${suffix}`, title: "Race fixture" } } });
    const admin = await createKnowledgeAdmin("race-admin");
    const client = await signInKnowledgeAdmin(admin);
    const ideaId = check(await client.rpc("admin_create_idea", {
      p_locale: "vi", p_slug: `race-${suffix}`, p_question: "Race?", p_short_answer: "Answer.",
    })) as string;
    const questionId = check(await client.rpc("submit_reader_question", {
      p_book_id: bookId, p_idea_id: null, p_body: "A concurrent question?", p_locale: "vi",
    })) as string;
    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError || !user) throw userError ?? new Error("Missing fixture user");
    const a = openSqlSession();
    const b = openSqlSession();
    const observer = openSqlSession();
    let second: Promise<string> | undefined;
    try {
      const actor = `set local role authenticated; select set_config('request.jwt.claim.sub','${user.id}',true)`;
      const link = `${actor}; select public.admin_answer_question('${questionId}', '${ideaId}')`;
      // The publication UPDATE is the precise trigger boundary under test; editorial readiness is
      // covered by the browser journey above.
      const publish = `update public.ideas set status='published' where id='${ideaId}'`;
      await a.query(`begin; set local statement_timeout='10s'; ${first === "publish" ? publish : link}`);
      const pid = await b.query("select pg_backend_pid()");
      let finished = false;
      second = b.query(`begin; set local statement_timeout='10s'; ${first === "publish" ? link : publish}; commit`);
      void second.then(() => { finished = true; }, () => { finished = true; });
      await expect.poll(async () => finished || (await observer.query(`select cardinality(pg_blocking_pids(${Number(pid)})) > 0`)) === "t").toBe(true);
      await a.query("commit");
      await second;
      const rows = check(await createServiceRoleClient().from("notification_outbox").select("payload").eq("question_id", questionId));
      expect(rows).toEqual([{ payload: { ideaId } }]);
    } finally {
      await Promise.all([a.close(), b.close(), observer.close()]);
      await second?.catch(() => {});
    }
  });
}

// S15: an admin's reply edit racing the worker's claim of the waiting row. The claim's row write
// (skip-locked select, then lease) is replayed against this row only, so other specs' rows stay
// unclaimed. Whichever commits first, a row the worker has not leased must be left for the new text.
for (const first of ["claim", "reply"] as const) {
  test(`a reply edit racing the claim still leaves the new reply to be mailed (${first} first)`, async () => {
    const suffix = unique();
    const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `reply-race-${suffix}`, title: "Reply race" } } });
    const reader = await createReader("reply-race-reader");
    const admin = await createReader("reply-race-admin", { admin: true });
    const a = openSqlSession();
    const b = openSqlSession();
    const observer = openSqlSession();
    let second: Promise<string> | undefined;
    try {
      const reviewId = await observer.query(
        `insert into public.book_reviews (book_id, profile_id, rating, body, locale) values ('${bookId}', '${reader.profileId}', 5, 'Race.', 'vi') returning id`,
      );
      await observer.query(`update public.book_reviews set author_reply = 'A', author_reply_at = now(), status = 'published' where id = '${reviewId}'`);
      const rowId = await observer.query(`select id from public.notification_outbox where review_id = '${reviewId}'`);
      const claim = `update public.notification_outbox set lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes'
        where id in (select id from public.notification_outbox where id = '${rowId}' and lease_token is null for update skip locked)`;
      const reply = `select set_config('request.jwt.claim.sub', (select auth_user_id::text from public.profiles where id = '${admin.profileId}'), true);
        set local role authenticated; select public.admin_reply_review('${reviewId}', 'B')`;
      await a.query(`begin; set local statement_timeout='10s'; ${first === "claim" ? claim : reply}`);
      const pid = await b.query("select pg_backend_pid()");
      let finished = false;
      second = b.query(`begin; set local statement_timeout='10s'; ${first === "claim" ? reply : claim}; commit`);
      void second.then(() => { finished = true; }, () => { finished = true; });
      await expect.poll(async () => finished || (await observer.query(`select cardinality(pg_blocking_pids(${Number(pid)})) > 0`)) === "t").toBe(true);
      await a.query("commit");
      await second;
      const waiting = await observer.query(
        `select count(*) from public.notification_outbox where review_id = '${reviewId}' and sent_at is null and lease_token is null`,
      );
      expect(waiting).toBe("1");
    } finally {
      await Promise.all([a.close(), b.close(), observer.close()]);
      await second?.catch(() => {});
    }
  });
}

test("concurrent create-answer and link-answer do not deadlock on the asked idea", async () => {
  const suffix = unique();
  const { bookId } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `fk-${suffix}`, title: "FK race" } } });
  const client = await signInKnowledgeAdmin(await createKnowledgeAdmin("fk-admin"));
  const { ideaId } = await seedPublishedIdea(client, {
    locale: "vi", slug: `fk-${suffix}`, question: "Asked idea?", shortAnswer: "Answer.", body: "Body.", bookIds: [bookId],
  });
  const questionId = check(await client.rpc("submit_reader_question", {
    p_book_id: null, p_idea_id: ideaId, p_body: "Question about an idea?", p_locale: "vi",
  })) as string;
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw error ?? new Error("Missing fixture user");
  const a = openSqlSession();
  const b = openSqlSession();
  const observer = openSqlSession();
  let second: Promise<string> | undefined;
  try {
    const actor = `set local role authenticated; select set_config('request.jwt.claim.sub','${user.id}',true)`;
    await a.query(`begin; set local statement_timeout='10s'; select id from public.reader_questions where id='${questionId}' for update`);
    const pid = await b.query("select pg_backend_pid()");
    second = b.query(`begin; set local statement_timeout='10s'; ${actor}; select public.admin_answer_question('${questionId}','${ideaId}'); commit`);
    void second.catch(() => {});
    await expect.poll(async () => (await observer.query(`select cardinality(pg_blocking_pids(${Number(pid)})) > 0`)) === "t").toBe(true);
    // Create-answer already owns the question lock, then checks the asked idea's FK when linking
    // the new idea. KEY SHARE must remain compatible with the competing link's idea lock.
    await a.query(`${actor}; select public.admin_answer_question_with_idea('${questionId}','vi','new-${suffix}','Answer?','Answer.'); commit`);
    await second;
    const row = check(await createServiceRoleClient().from("reader_questions").select("answer_idea_id").eq("id", questionId).single());
    expect(row.answer_idea_id).toBe(ideaId);
  } finally {
    await Promise.all([a.close(), b.close(), observer.close()]);
    await second?.catch(() => {});
  }
});
