import { expect, test } from "@playwright/test";

// Two specs that need no fixture at all, following e2e/admin-publication-transitions.spec.ts's
// "the preview resource route refuses an unauthenticated request" pattern. A random UUID is
// enough, because both assertions are about what happens *before* any publication is resolved.
//
// The second is the only test in this task that would catch Ruling AR being broken at the real
// HTTP layer. Every unit test calls the route's `GET` function directly, so a session gate added
// later in middleware, a layout, or the proxy would sail past all of them while silently breaking
// public samples for anonymous visitors.
const publicationId = "00000000-0000-0000-0000-0000000000ff";

test("the entitled manifest route refuses an unauthenticated request with 401", async ({ request }) => {
  const response = await request.get(`/api/reader/publications/${publicationId}/manifest`, {
    maxRedirects: 0,
  });

  // 401, not a redirect and not 404: the entitled routes answer an anonymous caller before any
  // lookup, so this says something about the caller and nothing about whether the publication
  // exists - the same response an invented id and a real one both get.
  expect(response.status()).toBe(401);
});

test("the sample manifest route answers an anonymous visitor with 404, never 401", async ({ request }) => {
  const response = await request.get(`/api/samples/${publicationId}/manifest`, { maxRedirects: 0 });

  // Ruling AR: no user gate on the sample path. A 401 here would mean a gate had appeared and
  // public samples were broken for everyone not signed in; a redirect would mean the same.
  expect(response.status()).toBe(404);
});
