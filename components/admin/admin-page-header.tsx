// The heading block every admin page opens with: an optional small-caps eyebrow, a Lora title,
// and a single line of supporting detail.
export function AdminPageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-10">
      {eyebrow ? (
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{eyebrow}</p>
      ) : null}
      <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em] sm:text-[2.5rem]">{title}</h1>
      {children ? <div className="text-[0.9375rem] leading-relaxed text-ink-soft">{children}</div> : null}
    </div>
  );
}

// A titled section separated by an Ink rule rather than boxed in a card (board 1a, principle 2).
export function AdminSection({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="scroll-mt-24 border-t border-ink pt-6" id={id}>
      <h2 className="mb-5 font-serif text-2xl font-normal">{title}</h2>
      {children}
    </section>
  );
}
