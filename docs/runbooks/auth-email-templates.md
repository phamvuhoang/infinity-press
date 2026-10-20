# Auth email templates

Paste-ready HTML for every Supabase Auth email. Copy each block into **Supabase Dashboard →
Authentication → Emails → Templates**, one template per tab.

These are English-only. Supabase serves one template per type with no per-user locale switch, so a
Vietnamese or Japanese reader gets this English mail and lands on the English site (English is the
platform default). See [Locale](#locale) to send the links to `/vi` or `/ja` instead.

## 1. Which link each template uses

Two link styles appear below, and the difference matters:

- **Direct link** — `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=…`
  goes straight to `app/auth/callback/route.ts`. It never touches Supabase's `/auth/v1/verify`
  endpoint, so the project's redirect allow-list cannot break it. This is the safer style, and it
  is what took sign-in down on 2026-09-23 when `SITE_URL` moved to the `www` origin while Supabase
  still allow-listed the apex only.
- **`{{ .ConfirmationURL }}`** — Supabase's own link. It goes through `/auth/v1/verify` and is
  therefore subject to the allow-list. Used below only where the app cannot accept the direct style.

`lib/auth/callback.ts` accepts exactly two `type` values, `email` and `recovery` (`otpTypes`).
That is why invite and email-change stay on `{{ .ConfirmationURL }}`.

| Supabase template | Used by | Link style | Ready to paste |
| --- | --- | --- | --- |
| Magic Link | `requestMagicLink()`, the customer's main sign-in | direct, `type=email` | yes |
| Confirm signup | a first-time address hitting `signInWithOtp({ shouldCreateUser: true })` | direct, `type=email` | yes |
| Reset Password | `requestPasswordReset()`, the internal staff fallback | direct, `type=recovery` | yes |
| Reauthentication | a 6-digit code, no link | `{{ .Token }}` | yes |
| Invite user | not used by the app today | `{{ .ConfirmationURL }}` | yes, see note |
| Change Email Address | not used by the app today | `{{ .ConfirmationURL }}` | yes, see note |

To move invite or email change onto the direct style, add `invite` and `email_change` to `otpTypes`
in `lib/auth/callback.ts` first. Until then the direct style would send those users to
`/en/sign-in?error=callback`.

## 2. Subjects

Every subject starts with `[InfinityPress]`, so the mail is easy to find and filter in a shared
inbox. Paste the subject into the template's **Subject** field exactly as shown:

| Template | Subject |
| --- | --- |
| Magic Link | `[InfinityPress] Your sign-in link` |
| Confirm signup | `[InfinityPress] Confirm your email address` |
| Reset Password | `[InfinityPress] Reset your password` |
| Reauthentication | `[InfinityPress] Your verification code` |
| Invite user | `[InfinityPress] You have been invited` |
| Change Email Address | `[InfinityPress] Confirm your new email address` |

## 3. House style

Every template below shares one skeleton, so a change to one is easy to mirror across the rest:

- Colours come from `app/globals.css`: Ivory `#f7f4ed` ground, Card `#fbf9f4`, Ink `#202421`,
  Deep Forest `#34473e` for the button, Sage-text `#5f6e64` for muted copy, Warm Sand hairline
  `#e4ded2`, Quiet Gold `#b59a64` used once, on the security note.
- Table layout with inline styles only. No flexbox, no grid, no `<style>` block, no web fonts —
  Outlook and Gmail strip or ignore all four.
- Georgia for headings and Helvetica/Arial for body, mirroring the site's serif/sans pairing with
  fonts that exist on every mail client.
- A hidden preheader line controls the inbox preview text instead of leaking the first sentence.
- Every link is also printed as plain text underneath, for clients that strip anchors.
- The brand is a text wordmark ("Infinity Press"), not an image, so nothing depends on remote
  images being loaded.
- Rounded corners degrade to square in Outlook. That is the only visual difference there.

### Locale

Links land on the English library because `lib/auth/callback.ts` falls back to `defaultLocale`
(`en`) when no destination is given. To send readers to another library, append
`&next=%2Fvi%2Flibrary&locale=vi` (or `%2Fja%2Flibrary` and `ja`) to the magic-link and
confirm-signup hrefs.

### Hardcoded origin

The hrefs use `{{ .SiteURL }}`, so they follow the Site URL field of the **Press** Supabase project.
Set that field to the Press origin (`https://infinitybooks.press`) and keep the same value in
`SITE_URL` on Vercel. Add `<origin>/auth/callback**` to the project's redirect allow-list. Never
paste another project's origin into these templates: a link to a different deployment would send
Press readers to the wrong site.

---

## 4. Magic Link

Subject: `[InfinityPress] Your sign-in link`

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Your sign-in link</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f4ed;">
<div style="display:none;font-size:1px;color:#f7f4ed;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Your one-time link to Infinity Press. It expires in one hour.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4ed;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="left" style="padding:0 4px 24px 4px;">
<p style="margin:0;font-family:Georgia,serif;font-size:20px;color:#202421;">Infinity Press</p>
</td></tr>
<tr><td style="background-color:#fbf9f4;border:1px solid #e4ded2;border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.3;font-weight:400;color:#202421;">Your sign-in link</h1>
<p style="margin:0 0 28px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a413d;">Follow the link below to continue to your library. No password needed.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#34473e" style="border-radius:8px;">
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;line-height:1;color:#f7f4ed;text-decoration:none;border-radius:8px;">Sign in to Infinity Press</a>
</td></tr></table>
<p style="margin:28px 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;">Button not working? Paste this into your browser:</p>
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;word-break:break-all;"><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email" style="color:#34473e;">{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;"><tr>
<td style="border-left:3px solid #b59a64;padding:4px 0 4px 16px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5f6e64;">This link expires in one hour and can be used once. If you did not ask to sign in, ignore this email — nobody can reach your account without it.</p>
</td></tr></table>
</td></tr>
<tr><td align="left" style="padding:24px 8px 0 8px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#77877b;">Infinity Press · <a href="{{ .SiteURL }}" style="color:#77877b;">{{ .SiteURL }}</a><br>You received this because someone entered this address on our sign-in page.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 5. Confirm signup

Subject: `[InfinityPress] Confirm your email address`

Sent instead of the magic link the first time an address is seen, because `requestMagicLink()`
passes `shouldCreateUser: true`. Keep the two consistent: a reader cannot tell which one they
triggered.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Confirm your email address</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f4ed;">
<div style="display:none;font-size:1px;color:#f7f4ed;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Confirm your address to open your Infinity Press library.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4ed;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="left" style="padding:0 4px 24px 4px;">
<p style="margin:0;font-family:Georgia,serif;font-size:20px;color:#202421;">Infinity Press</p>
</td></tr>
<tr><td style="background-color:#fbf9f4;border:1px solid #e4ded2;border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.3;font-weight:400;color:#202421;">Welcome to Infinity Press</h1>
<p style="margin:0 0 28px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a413d;">Confirm this address and your library opens straight away. You will never need a password — each time you sign in, we send a link like this one.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#34473e" style="border-radius:8px;">
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;line-height:1;color:#f7f4ed;text-decoration:none;border-radius:8px;">Confirm and open my library</a>
</td></tr></table>
<p style="margin:28px 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;">Button not working? Paste this into your browser:</p>
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;word-break:break-all;"><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email" style="color:#34473e;">{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;"><tr>
<td style="border-left:3px solid #b59a64;padding:4px 0 4px 16px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5f6e64;">This link expires in one hour and can be used once. If you did not sign up, ignore this email and no account will be created.</p>
</td></tr></table>
</td></tr>
<tr><td align="left" style="padding:24px 8px 0 8px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#77877b;">Infinity Press · <a href="{{ .SiteURL }}" style="color:#77877b;">{{ .SiteURL }}</a><br>You received this because this address was entered on our sign-in page.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 6. Reset Password

Subject: `[InfinityPress] Reset your password`

Password access is the internal staff fallback, not a customer path, so this link carries
`next=/internal/en/update-password` — the same destination `requestPasswordReset()` asks for. The
wording says so, to keep a customer who receives it from expecting a second way in.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f4ed;">
<div style="display:none;font-size:1px;color:#f7f4ed;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Choose a new password for your Infinity Press staff account.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4ed;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="left" style="padding:0 4px 24px 4px;">
<p style="margin:0;font-family:Georgia,serif;font-size:20px;color:#202421;">Infinity Press</p>
</td></tr>
<tr><td style="background-color:#fbf9f4;border:1px solid #e4ded2;border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.3;font-weight:400;color:#202421;">Reset your password</h1>
<p style="margin:0 0 28px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a413d;">Follow the link below to choose a new password for your staff account. Your current password keeps working until you do.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#34473e" style="border-radius:8px;">
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=%2Finternal%2Fen%2Fupdate-password" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;line-height:1;color:#f7f4ed;text-decoration:none;border-radius:8px;">Choose a new password</a>
</td></tr></table>
<p style="margin:28px 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;">Button not working? Paste this into your browser:</p>
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;word-break:break-all;"><a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=%2Finternal%2Fen%2Fupdate-password" style="color:#34473e;">{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=%2Finternal%2Fen%2Fupdate-password</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;"><tr>
<td style="border-left:3px solid #b59a64;padding:4px 0 4px 16px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5f6e64;">This link expires in one hour and can be used once. If you did not ask for it, ignore this email — your password stays as it is. Readers do not need a password: sign in from the site and we send you a link instead.</p>
</td></tr></table>
</td></tr>
<tr><td align="left" style="padding:24px 8px 0 8px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#77877b;">Infinity Press · <a href="{{ .SiteURL }}" style="color:#77877b;">{{ .SiteURL }}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 7. Reauthentication

Subject: `[InfinityPress] Your verification code`

A code, not a link — Supabase asks the reader to type it back into the page they are already on.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Your verification code</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f4ed;">
<div style="display:none;font-size:1px;color:#f7f4ed;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Enter this code to confirm it is you.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4ed;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="left" style="padding:0 4px 24px 4px;">
<p style="margin:0;font-family:Georgia,serif;font-size:20px;color:#202421;">Infinity Press</p>
</td></tr>
<tr><td style="background-color:#fbf9f4;border:1px solid #e4ded2;border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.3;font-weight:400;color:#202421;">Confirm it is you</h1>
<p style="margin:0 0 24px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a413d;">Enter this code on the page you left open:</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
<td align="center" bgcolor="#efeae0" style="border-radius:8px;padding:22px 16px;">
<span style="font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:bold;letter-spacing:10px;color:#202421;">{{ .Token }}</span>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;"><tr>
<td style="border-left:3px solid #b59a64;padding:4px 0 4px 16px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5f6e64;">This code expires in one hour. We will never ask you for it by phone, chat or reply — if someone does, they are not us.</p>
</td></tr></table>
</td></tr>
<tr><td align="left" style="padding:24px 8px 0 8px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#77877b;">Infinity Press · <a href="{{ .SiteURL }}" style="color:#77877b;">{{ .SiteURL }}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 8. Invite user

Subject: `[InfinityPress] You have been invited`

Uses `{{ .ConfirmationURL }}`: `lib/auth/callback.ts` does not accept `type=invite` today, so a
direct link would land the guest on `/en/sign-in?error=callback`. That also means this link depends
on the redirect allow-list — keep `{{ .SiteURL }}/auth/callback**` listed under
Authentication → URL Configuration.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>You have been invited to Infinity Press</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f4ed;">
<div style="display:none;font-size:1px;color:#f7f4ed;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Accept your invitation to Infinity Press.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4ed;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="left" style="padding:0 4px 24px 4px;">
<p style="margin:0;font-family:Georgia,serif;font-size:20px;color:#202421;">Infinity Press</p>
</td></tr>
<tr><td style="background-color:#fbf9f4;border:1px solid #e4ded2;border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.3;font-weight:400;color:#202421;">You have been invited</h1>
<p style="margin:0 0 28px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a413d;">Someone at Infinity Press invited <strong style="color:#202421;">{{ .Email }}</strong> to join. Accept below to set up your account.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#34473e" style="border-radius:8px;">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;line-height:1;color:#f7f4ed;text-decoration:none;border-radius:8px;">Accept the invitation</a>
</td></tr></table>
<p style="margin:28px 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;">Button not working? Paste this into your browser:</p>
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;word-break:break-all;"><a href="{{ .ConfirmationURL }}" style="color:#34473e;">{{ .ConfirmationURL }}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;"><tr>
<td style="border-left:3px solid #b59a64;padding:4px 0 4px 16px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5f6e64;">If you were not expecting this invitation, ignore this email and nothing happens.</p>
</td></tr></table>
</td></tr>
<tr><td align="left" style="padding:24px 8px 0 8px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#77877b;">Infinity Press · <a href="{{ .SiteURL }}" style="color:#77877b;">{{ .SiteURL }}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 9. Change Email Address

Subject: `[InfinityPress] Confirm your new email address`

Uses `{{ .ConfirmationURL }}` for the same reason as the invite: `type=email_change` is not in
`otpTypes`. Supabase sends this to both the old and the new address when "Secure email change" is
on, which is why the copy names both.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Confirm your new email address</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f4ed;">
<div style="display:none;font-size:1px;color:#f7f4ed;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Confirm the address change on your Infinity Press account.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f4ed;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="left" style="padding:0 4px 24px 4px;">
<p style="margin:0;font-family:Georgia,serif;font-size:20px;color:#202421;">Infinity Press</p>
</td></tr>
<tr><td style="background-color:#fbf9f4;border:1px solid #e4ded2;border-radius:12px;padding:40px 36px;">
<h1 style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.3;font-weight:400;color:#202421;">Confirm your new address</h1>
<p style="margin:0 0 24px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#3a413d;">Your Infinity Press account is moving from <strong style="color:#202421;">{{ .Email }}</strong> to <strong style="color:#202421;">{{ .NewEmail }}</strong>. Confirm below to finish the change — your library and reading progress come with you.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#34473e" style="border-radius:8px;">
<a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:bold;line-height:1;color:#f7f4ed;text-decoration:none;border-radius:8px;">Confirm the change</a>
</td></tr></table>
<p style="margin:28px 0 8px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;">Button not working? Paste this into your browser:</p>
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:#5f6e64;word-break:break-all;"><a href="{{ .ConfirmationURL }}" style="color:#34473e;">{{ .ConfirmationURL }}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;"><tr>
<td style="border-left:3px solid #b59a64;padding:4px 0 4px 16px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#5f6e64;">If you did not ask to change your address, ignore this email and tell us — the change does not happen until both addresses confirm.</p>
</td></tr></table>
</td></tr>
<tr><td align="left" style="padding:24px 8px 0 8px;">
<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#77877b;">Infinity Press · <a href="{{ .SiteURL }}" style="color:#77877b;">{{ .SiteURL }}</a></p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
```

---

## 10. After pasting

1. Send yourself one of each from the app (`/en/sign-in` for the magic link,
   `/internal/en/forgot-password` for the reset) and open them on a phone and in Gmail's web client.
2. Confirm the link lands signed in on `/en/library`, not on `/en/sign-in?error=callback`. An
   `error=callback` means the `type` in the href is not one `otpTypes` accepts.
3. Watch the Resend dashboard, not just your inbox: a template that fails to render reaches Supabase
   as a 500 and never becomes a Resend delivery at all.

If nothing arrives and Resend shows no attempt, the fault is between Supabase and Resend, not in
these templates — reproduce it directly to get the real message instead of the app's generic one:

```bash
curl -sS -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/otp" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","create_user":true}'
```

A `500 unexpected_failure / "Error sending magic link email"` is an SMTP fault; its `error_id`
appears in Dashboard → Logs → Auth Logs with the underlying SMTP error. On 2026-09-24 that error
turned out to be a typo in the SMTP host field (`smpt.resend.com`).
