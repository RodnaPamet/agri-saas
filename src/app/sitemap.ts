import type { MetadataRoute } from 'next';

import { getAppBaseUrl } from '@/lib/auth/app-base-url';
import { listIndexableFarmHandles } from '@/app-layer/usecases/public-farm-profile';
import { isFeatureEnabled } from '@/lib/feature-flags';

/**
 * `sitemap.xml` — the indexable public profiles (P6.5, #1814).
 *
 * ## It is EMPTY today, and that is the correct output
 *
 * Every projected profile currently carries `indexable: false`, because the
 * per-field control belongs to P6.6 (#1815) and the safe default in this
 * direction is off: an indexed page outlives its withdrawal, since a cached
 * snapshot is not ours to recall.
 *
 * So this ships listing nothing. That is deliberate rather than unfinished —
 * the alternative, listing every published farm, would invite crawlers to
 * index pages whose owners have not been asked yet.
 *
 * ## `indexable`, not `published`
 *
 * A row exists only while a farm is published, so the filter is the narrower
 * question: has this farm agreed to be FOUND? A sitemap is an invitation to
 * crawl, and publishing a page is not the same decision as asking for it to
 * be indexed.
 *
 * ## `lastModified` is the projection's own timestamp
 *
 * `projectedAt` moves when the public content changes and not when the owner
 * edits a draft, which is exactly what a crawler should see. Using
 * `FarmBrand.updatedAt` would have leaked private activity — a crawler could
 * tell a farm was being worked on — and `new Date()` would claim everything
 * changed on every fetch, which trains a crawler to ignore the field.
 *
 * ## force-dynamic
 *
 * A profile withdrawn or de-indexed must leave the sitemap, and P6.10 bounds
 * that at 60s. A statically generated sitemap would keep inviting crawlers to
 * a page that is already 404ing.
 */
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    // The sanctioned resolver, not a hardcoded origin. It prefers `APP_URL`
    // and falls back to `NEXTAUTH_URL`, which the env schema requires off
    // Vercel — so the app cannot boot without knowing its own origin, and a
    // literal here would have been a second source of truth that drifts on
    // the day the domain changes.
    const base = getAppBaseUrl();
    // Flagged off means no farm is invited to be crawled (#1886). The
    // sitemap itself still answers — it is a site-level document and a 404
    // here would be a different claim than "no farms are indexable".
    if (!(await isFeatureEnabled('social.public-profile', null))) return [];

    const profiles = await listIndexableFarmHandles();

    return profiles.map((p) => ({
        url: `${base}/f/${p.handle}`,
        lastModified: p.projectedAt,
        // A farm page changes when its owner edits it, which is rare and
        // irregular. `weekly` is a hint rather than a contract and crawlers
        // largely derive their own cadence, so an honest low number beats a
        // flattering one that gets discounted.
        changeFrequency: 'weekly' as const,
    }));
}
