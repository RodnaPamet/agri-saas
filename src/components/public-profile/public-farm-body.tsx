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
}

export interface PublicFarmBodyLabels {
    /** Already interpolated, e.g. «Област: Добрич». Null hides the line. */
    readonly oblastLine: string | null;
    readonly cropsTitle: string;
    readonly aboutTitle: string;
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
