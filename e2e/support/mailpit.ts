// Auth-email specs require a local Supabase stack with Mailpit, for example:
// E2E_MAILPIT_URL=http://127.0.0.1:54324 NEXT_PUBLIC_SUPABASE_URL=... npm run test:e2e
export const mailpitUrl = process.env.E2E_MAILPIT_URL;

type MailpitSearch = { messages: { ID: string }[] };
type MailpitMessage = { HTML: string };

export async function readLatestLink(email: string) {
  const query = new URLSearchParams({ query: `to:"${email}"` });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const search = (await (await fetch(`${mailpitUrl}/api/v1/search?${query}`)).json()) as MailpitSearch;
    const id = search.messages[0]?.ID;
    if (id) {
      const message = (await (await fetch(`${mailpitUrl}/api/v1/message/${id}`)).json()) as MailpitMessage;
      const href = message.HTML.match(/href="([^"]+)"/)?.[1];
      if (href) return href.replaceAll("&amp;", "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`No authentication email arrived for ${email}`);
}

// How many messages have reached this address's SMTP inbox.
//
// The gift journey needs this to assert a NEGATIVE: the gift claim message - the one mail in the
// product that carries a live credential in its body - goes through the no-network adapter
// (EMAIL_PROVIDER=test), so after the operations worker has delivered it the recipient's Mailpit
// inbox must still be empty. A claim URL sitting in a real inbox here would mean the suite had
// quietly acquired a mail path that a misconfigured environment could point somewhere else.
export async function countMessagesFor(email: string): Promise<number> {
  const query = new URLSearchParams({ query: `to:"${email}"` });
  const search = (await (await fetch(`${mailpitUrl}/api/v1/search?${query}`)).json()) as MailpitSearch;
  return search.messages.length;
}
