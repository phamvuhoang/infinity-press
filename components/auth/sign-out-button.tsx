import { signOut } from "@/app/auth/actions";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/lib/i18n/config";

export function SignOutButton({
  className,
  label,
  locale,
  variant = "outline",
}: {
  className?: string;
  label: string;
  locale: Locale;
  variant?: "outline" | "ghost";
}) {
  return (
    <form action={signOut} className={className}>
      <input name="locale" type="hidden" value={locale} />
      <Button type="submit" variant={variant}>
        {label}
      </Button>
    </form>
  );
}
