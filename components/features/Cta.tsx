interface CtaProps {
  text: string;
  href: string;
}

/** No cart, no checkout (spec §10) — the single job here is a clean handoff to BASE. */
export function Cta({ text, href }: CtaProps) {
  return (
    <section className="border-t border-line px-6 py-20 text-center sm:py-28">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block border border-ink px-10 py-4 text-xs uppercase tracking-label text-ink transition-colors hover:bg-ink hover:text-white"
      >
        {text}
      </a>
    </section>
  );
}
