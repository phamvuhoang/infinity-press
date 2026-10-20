import Link from "next/link";

import { Logo } from "@/components/brand/logo";

// Sign-in and the internal password pages. No design board covers authentication yet, so this
// applies the system from boards 1a/1d directly: Ivory ground, the wordmark, a narrow (560px)
// column, a Lora heading, and a form set on a single Ink rule rather than inside a card.
export function AuthCard({
  children,
  description,
  footer,
  homeHref,
  title,
}: {
  children: React.ReactNode;
  description: string;
  footer?: { href: string; label: string; prompt: string };
  homeHref: string;
  title: string;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-ivory">
      <header className="border-b border-hairline">
        <div className="mx-auto flex min-h-[4.5rem] max-w-[90rem] items-center px-4 sm:px-8 lg:px-16">
          <Logo href={homeHref} />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 py-16 sm:items-center sm:py-24" id="main-content">
        <div className="w-full max-w-[35rem]">
          <h1 className="mb-4 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em] sm:text-[2.5rem]">{title}</h1>
          <p className="mb-9 font-serif text-lg leading-normal text-ink-soft">{description}</p>
          <div className="space-y-6 border-t border-ink pt-7">
            {children}
            {footer ? (
              <p className="text-sm text-sage-text">
                {footer.prompt}{" "}
                <Link
                  className="font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
                  href={footer.href}
                >
                  {footer.label}
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
