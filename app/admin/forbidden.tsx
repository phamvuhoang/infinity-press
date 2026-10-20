import { ForbiddenPage } from "@/components/forbidden-page";

// Rendered by the `forbidden()` interrupt (see lib/auth/admin.ts). /admin is English-only, so a
// denied visitor reads English here and lands on the English home.
export default function Forbidden() {
  return <ForbiddenPage locale="en" />;
}
