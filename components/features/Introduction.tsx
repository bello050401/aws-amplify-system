import Image from "next/image";

interface IntroductionProps {
  intro: string;
  productGroupNotes: string;
  secondaryImageUrl?: string;
}

/** Text stays short on purpose (spec §13): a lookbook reads by looking, not by paragraph. */
export function Introduction({ intro, productGroupNotes, secondaryImageUrl }: IntroductionProps) {
  return (
    <section className="mx-auto max-w-content px-6 py-16 sm:py-24">
      <div className="grid grid-cols-1 gap-10 sm:grid-cols-5 sm:gap-16">
        <div className="sm:col-span-2">
          <p className="text-lg font-light leading-relaxed text-ink sm:text-xl">{intro}</p>
          <p className="mt-6 text-sm font-light leading-relaxed text-muted">{productGroupNotes}</p>
        </div>
        {secondaryImageUrl && (
          <div className="relative aspect-[4/5] sm:col-span-3">
            <Image
              src={secondaryImageUrl}
              alt=""
              fill
              sizes="(min-width: 640px) 60vw, 100vw"
              className="object-cover"
            />
          </div>
        )}
      </div>
    </section>
  );
}
