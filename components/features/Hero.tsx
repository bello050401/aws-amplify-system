import Image from "next/image";

interface HeroProps {
  brand?: string;
  title: string;
  headline: string;
  imageUrl: string;
}

/** Photo is the whole point (spec §10/§12): one large frame, brand + title + one line, nothing else competing for attention. */
export function Hero({ brand, title, headline, imageUrl }: HeroProps) {
  return (
    <section className="relative h-[78vh] min-h-[520px] w-full">
      <Image
        src={imageUrl}
        alt={title}
        fill
        priority
        sizes="100vw"
        className="object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent" />
      <div className="absolute inset-x-0 bottom-0 px-6 pb-10 text-white sm:px-12 sm:pb-14">
        <div className="mx-auto max-w-content">
          {brand && (
            <p className="text-xs uppercase tracking-label text-white/80">{brand}</p>
          )}
          <h1 className="mt-3 max-w-3xl text-3xl font-light leading-snug sm:text-5xl">
            {title}
          </h1>
          <p className="mt-4 max-w-xl text-sm font-light text-white/90 sm:text-base">
            {headline}
          </p>
        </div>
      </div>
    </section>
  );
}
