/**
 * The public farm page's body, as ONE component — P6.6 (#1815).
 *
 * ## Why this was extracted
 *
 * The editor needs a live preview, and a preview that reimplements the page it
 * claims to show is a preview that can lie. The two would drift the first time
 * somebody changed a heading level or a spacing class on one of them, and the
 * drift would be invisible: both would render, both would look plausible, and
 * only a farmer comparing them would know.
 *
 * So `/f/[handle]/page.tsx` and the editor's preview pane render the SAME
 * component. There is one markup and two call sites.
 *
 * ## Purely presentational, deliberately
 *
 * No data fetching, no `getTranslations`, no `useTranslations`. Labels arrive
 * as already-formatted strings.
 *
 * That is what lets both callers use it. The page is a Server Component that
 * resolves copy with `getTranslations`; the editor is a `'use client'` tree
 * that uses `useTranslations`. A component reaching for either one would work
 * in one place and fail in the other, and a component taking a FORMATTING
 * FUNCTION as a prop could not cross the server/client boundary at all.
 * Strings cross it fine.
 *
 * `oblastLine` is pre-formatted for the same reason: on the page it is
 * `t('oblast', { oblast })`, an interpolation the caller owns.
 *
 * ## The `data-testid`s are part of the contract
 *
 * `tests/guards/public-surface-skips-app-chrome.test.ts` and the PII crawler
 * test address this markup by test id. They moved here with it rather than
 * being re-invented, so those guards keep pointing at the real page.
 */
import { Heading } from '@/components/ui/typography';

export interface PublicFarmBodyProfile {
    readonly displayName: string;
    readonly tagline: string | null;
    readonly oblast: string | null;
    readonly crops: readonly string[];
    readonly about: string | null;
    /** Root-relative URL of the logo, or null. P6.3 (#1812). */
    readonly logoUrl: string | null;
    /** Root-relative URLs of the gallery, in display order. */
    readonly photoUrls: readonly string[];
}

export interface PublicFarmBodyLabels {
    /** Already interpolated, e.g. «Област: Добрич». Null hides the line. */
    readonly oblastLine: string | null;
    readonly cropsTitle: string;
    readonly aboutTitle: string;
    /** Alt text for the logo, already naming the farm. */
    readonly logoAlt: string;
    /**
     * Alt text per photograph, by index — `photoAlt(1)` for the first.
     *
     * A FUNCTION of the index rather than a pre-built array, because the
     * caller owns the interpolation and the count comes from the profile. It
     * crosses the server/client boundary because both callers build it from
     * their own `t()` — the component never formats anything itself.
     */
    readonly photoAlt: (oneBased: number) => string;
}

export function PublicFarmBody({
    profile,
    labels,
}: {
    profile: PublicFarmBodyProfile;
    labels: PublicFarmBodyLabels;
}) {
    return (
        <>
            <Heading level={1} data-testid="public-farm-name">
                {profile.displayName}
            </Heading>

            {profile.logoUrl ? (
                /* The box reserves space BEFORE the bytes arrive, which is the
                   whole reason it is a fixed square with the image absolutely
                   filling it. `lighthouserc.json` gates `/f/.*` on
                   `cumulative-layout-shift` at 0.05 as an ERROR, and an image
                   with no intrinsic dimensions declared is the classic way to
                   blow a CLS budget — the heading and everything under it jump
                   down the moment the logo decodes.
                
                   We cannot declare width/height: the projection stores a
                   content hash and nothing else, so the server does not know
                   the pixels. Reserving a box is what works without them. */
                <div
                    className="relative mt-6 h-24 w-24 overflow-hidden rounded-lg bg-bg-subtle"
                    data-testid="public-farm-logo"
                >
                    {/* A plain `<img>`, not `next/image`, and deliberately.
                        The optimizer would fetch this route server-side and
                        re-encode it — a round trip and a second encode of an
                        image the upload pipeline has already fitted to 1600px
                        and whose response is `immutable`. It would also put
                        optimizer traffic through a rate-limited public route.
                
                        `object-contain`, not `cover`: a wide logo must not be
                        cropped to a square. Same reasoning as the stored
                        bytes, which are fitted `inside` rather than cropped. */}
                    <img
                        src={profile.logoUrl}
                        alt={labels.logoAlt}
                        className="absolute inset-0 h-full w-full object-contain"
                        /* EAGER and high priority: it is above the fold and is
                           the likeliest LCP element now that the page has an
                           image at all. Lazy-loading the LCP element is a
                           known way to lose a second. */
                        loading="eager"
                        fetchPriority="high"
                        decoding="async"
                    />
                </div>
            ) : null}

            {profile.tagline ? (
                <p className="mt-2 text-content-muted" data-testid="public-farm-tagline">
                    {profile.tagline}
                </p>
            ) : null}

            {profile.oblast && labels.oblastLine ? (
                <p className="mt-4 text-sm text-content-muted" data-testid="public-farm-oblast">
                    {labels.oblastLine}
                </p>
            ) : null}

            {profile.crops.length > 0 ? (
                <section className="mt-6" data-testid="public-farm-crops">
                    {/* A real `<h2>` via the primitive, not an `<Eyebrow>`:
                        `Eyebrow` renders a `<span>`, and on a PUBLIC page the
                        document outline is read by screen readers and by
                        crawlers once a farm opts into indexing. A label that
                        looks like a heading and is not one costs both. */}
                    <Heading level={2}>{labels.cropsTitle}</Heading>
                    <ul className="mt-2 flex flex-wrap gap-tight">
                        {profile.crops.map((crop) => (
                            <li
                                key={crop}
                                className="rounded-full border border-border-subtle px-3 py-1 text-sm"
                            >
                                {crop}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {profile.photoUrls.length > 0 ? (
                <section className="mt-6" data-testid="public-farm-photos">
                    {/* No heading. The gallery is not a titled section the way
                        «Култури» is — a heading would need copy, and copy for
                        a row of pictures with no captions says nothing a
                        screen-reader user cannot get from the alt text. The
                        `<ul>` carries the structure instead. */}
                    <ul className="grid grid-cols-2 gap-tight sm:grid-cols-3">
                        {profile.photoUrls.map((url, i) => (
                            <li
                                key={url}
                                /* 4:3, fixed, for the CLS reason above. */
                                className="relative aspect-[4/3] overflow-hidden rounded-lg bg-bg-subtle"
                            >
                                <img
                                    src={url}
                                    alt={labels.photoAlt(i + 1)}
                                    className="absolute inset-0 h-full w-full object-contain"
                                    /* LAZY, unlike the logo. These are below
                                       the fold on a phone, and a lazy image is
                                       not a candidate for LCP — which is what
                                       keeps six photographs from competing
                                       with the heading for the 2200 ms gate. */
                                    loading="lazy"
                                    decoding="async"
                                />
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {profile.about ? (
                <section className="mt-6" data-testid="public-farm-about">
                    <Heading level={2}>{labels.aboutTitle}</Heading>
                    {/* Plain text, rendered as text. The value is sanitised on
                        the way into `FarmBrand` and the projection copies it
                        verbatim, so there is no markup to honour — and
                        rendering it as HTML would make the sanitiser the only
                        thing between a farm and an XSS on a page served to
                        strangers. */}
                    <p className="mt-2 whitespace-pre-line">{profile.about}</p>
                </section>
            ) : null}
        </>
    );
}
