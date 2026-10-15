import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isFeatureEnabled } from '@/lib/feature-flags';
import { getTranslations } from 'next-intl/server';

import { readPublicFarmProfile } from '@/app-layer/usecases/public-farm-profile';
import { PublicFarmBody } from '@/components/public-profile/public-farm-body';

/**
 * A farm in public — `/f/[handle]` (P6.5, #1814).
 *
 * ## It reads the projection, never a tenant table
 *
 * The phase's rule, and `readPublicFarmProfile` is the only way in: one
 * `findUnique` on `PublicFarmProfile` under
 * `runWithoutRls({ reason: 'public-projection-read' })`. The bypass is
 * load-bearing rather than convenient — an anonymous visitor has no session,
 * no tenant and no membership, so there is no narrower context to use instead.
 *
 * The projection holds no `tenantId`, so there is nothing to join through even
 * by accident, and it has no PII columns at all: ЕГН, ЕИК, the address,
 * municipality and settlement live on `FarmProfile` and have no counterpart
 * there. P6.10 asks for zero hits of those in the HTML — this page satisfies
 * it structurally, because the values never reach the process.
 *
 * ## A private profile and a missing one are the same 404
 *
 * Required, so a stranger cannot enumerate which farms exist by probing
 * handles. It comes for free rather than from matching two error paths: a
 * projection row EXISTS only while the farm is published — the writer deletes
 * it on withdrawal rather than flagging it — so "not published" and "never
 * existed" are one absence, and `notFound()` is reached by one code path.
 *
 * There is nothing here to keep in step by hand, which is the point. A
 * `published` column on the projection would have needed exactly that.
 *
 * ## No session, deliberately
 *
 * `/f` is in `PUBLIC_PATH_PREFIXES`, so the Edge does not gate it and this
 * component never reads a session. A shared link or a printed QR code
 * (P6.7) reaches it with no account, which is the whole point.
 *
 * ## `force-dynamic`
 *
 * The page must stop answering within 60s of an unpublish (P6.10). A static
 * render would serve a cached page after the row is gone — the projection is
 * the source of truth and it is read per request.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    readonly params: Promise<{ handle: string }>;
}

/**
 * Title, description and the robots directive.
 *
 * `indexable` is the projection's own column and is always `false` today
 * (P6.6 ships the control), so every profile is `noindex` until a farm opts
 * in. That is the safe default in the direction that matters: a page can be
 * indexed and cached long after it is withdrawn, and nobody can recall a
 * snapshot.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { handle } = await params;
    // Gated independently of the page below. `generateMetadata` runs on its
    // own, so a gate only on the default export would still publish the
    // farm's name and tagline as a <title> and description for a page that
    // 404s — answering the question the 404 refuses to.
    if (!(await isFeatureEnabled('social.public-profile', null))) {
        return { robots: { index: false, follow: false } };
    }
    const profile = await readPublicFarmProfile(handle);
    if (!profile) {
        // The same metadata a missing farm gets, for the same anti-enumeration
        // reason as the 404 itself — a distinctive title would answer the
        // question the status code refuses to.
        return { robots: { index: false, follow: false } };
    }
    return {
        title: profile.displayName,
        description: profile.tagline ?? undefined,
        robots: profile.indexable
            ? { index: true, follow: true }
            : { index: false, follow: false },
    };
}

export default async function PublicFarmProfilePage({ params }: PageProps) {
    const { handle } = await params;
    // #1197's standing rule: every social surface sits behind a runtime
    // flag, default OFF (#1886). This surface is ANONYMOUS, so the flag is
    // resolved with a null user — a key with no cohorts then applies
    // globally, which is what a public page needs.
    //
    // Gated BEFORE the read, so a flagged-off deployment does not query
    // the projection at all.
    if (!(await isFeatureEnabled('social.public-profile', null))) notFound();
    const profile = await readPublicFarmProfile(handle);
    if (!profile) notFound();

    const t = await getTranslations('publicFarm');

    return (
        <main className="mx-auto max-w-2xl px-4 py-10" data-testid="public-farm-profile">
            {/* The body is a SHARED component (#1815): the editor's live
                preview renders this same markup, so a preview cannot drift
                from the page it claims to show. Labels are resolved here,
                server-side, and passed as strings — which is what lets a
                `'use client'` preview use the identical component. */}
            <PublicFarmBody
                profile={profile}
                labels={{
                    oblastLine: profile.oblast ? t('oblast', { oblast: profile.oblast }) : null,
                    cropsTitle: t('cropsTitle'),
                    aboutTitle: t('aboutTitle'),
                }}
            />
        </main>
    );
}
