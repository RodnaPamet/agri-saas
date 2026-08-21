/**
 * market-news-pull — aggregate free agricultural RSS/Atom feeds into the GLOBAL
 * MarketNewsItem cache that backs the Trends → News tab.
 *
 * For each configured feed (src/lib/news/feeds.ts, overridable via
 * MARKET_NEWS_FEEDS) the job fetches the newest items, sanitises the title +
 * summary to plain text, categorises each item (feed default + deterministic
 * BG/EN keyword promotion), and idempotently upserts on `guidHash`
 * (sha256(feedSlug‖guid)). Finally it prunes items older than 60 days so the
 * table stays bounded.
 *
 * Like the market-price cache, MarketNewsItem is a GLOBAL table (no tenantId,
 * no RLS — public reference data identical for every tenant), so the ordinary
 * `prisma` singleton (superuser-bypass) writes it directly with no per-tenant
 * context. Fail-soft per feed: one unreachable feed is logged and skipped, never
 * failing the batch. All writes are idempotent, so a retry never duplicates a
 * headline.
 *
 * @module jobs/market-news-pull
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { resolveNewsFeeds } from '@/lib/news/feeds';
import { fetchFeed } from '@/lib/news/rss-client';
import { categorize } from '@/lib/news/categorize';
import type { MarketNewsPullPayload } from './types';
import { isHttpUrl } from '@/lib/security/safe-url';

const COMPONENT = 'market-news-pull';
/** Items older than this are pruned each run so the table stays bounded. */
const RETENTION_DAYS = 60;
/** Per-feed newest-items cap. */
const MAX_ITEMS_PER_FEED = 40;
/** Column length caps — keep headlines/excerpts sane, never store blobs. */
/**
 * ── LEGAL FRAME: why these caps exist ────────────────────────────────
 *
 * This aggregator stores and renders **only** title + a short snippet +
 * the source + an outbound link, and every card links **out** to the
 * publisher. **No full-text republication. No scraping of paywalled or
 * partner content.** That is the constraint the whole feature is built
 * inside — the caps below are its implementation, not arbitrary numbers.
 *
 * Recovered from `feat/trends-news` @ 545f441a, an unmerged WIP branch
 * that stated it in five places while `main`, which shipped the feature
 * by a different route, stated it in none. Grepping this tree for
 * `legal|copyright|republicat|paywall` returned nothing before this
 * comment existed. The behaviour complied; the reason was undocumented,
 * which is a different thing and a more fragile one.
 *
 * **Why it matters in this repo specifically:** this is an offline-first
 * product with a documented cold-start and rural-LTE concern, so
 * "cache the article text so operators can read it offline" is a
 * plausible and well-intentioned next feature. It would breach the frame
 * above. Nothing else in the codebase would have told that engineer.
 *
 * **One discrepancy, recorded rather than silently reconciled.** The
 * source branch capped the snippet at **300** characters; `SUMMARY_MAX`
 * here is **500**. Both are snippets rather than full text, so neither
 * is obviously outside the frame — but the number should be a deliberate
 * choice, and right now it is drift between two implementations. If
 * there is a contractual figure, it belongs here. See issue #670.
 *
 * Related: the agroportal.bg exclusion in `@/lib/news/feeds`, which is a
 * commercial constraint rather than a technical one.
 */
const TITLE_MAX = 300;
const SUMMARY_MAX = 500;

/** The single Prisma delegate this job touches (a GLOBAL cache table). */
type NewsDbClient = Pick<PrismaClient, 'marketNewsItem'>;

/** Injectable seams so tests drive the pull without real network / prod DB. */
export interface MarketNewsPullDeps {
    fetchFeedImpl?: typeof fetchFeed;
    db?: NewsDbClient;
    /** Clock injection for a deterministic prune cutoff in tests. */
    now?: () => Date;
}

export interface MarketNewsPullResult {
    feeds: number;
    /** Raw items fetched across all feeds (pre-dedupe). */
    fetched: number;
    /** Items upserted (created or refreshed). */
    upserted: number;
    /** Old items pruned. */
    pruned: number;
}

/** Namespaced dedupe/upsert key: sha256(feedSlug‖guid). */
function guidHash(feedSlug: string, guid: string): string {
    return createHash('sha256').update(`${feedSlug}\n${guid}`).digest('hex');
}

export async function runMarketNewsPull(
    payload: MarketNewsPullPayload = {},
    deps: MarketNewsPullDeps = {},
): Promise<MarketNewsPullResult> {
    const db = (deps.db ?? prisma) as NewsDbClient;
    const doFetch = deps.fetchFeedImpl ?? fetchFeed;
    const now = (deps.now ?? (() => new Date()))();

    const allFeeds = resolveNewsFeeds(env.MARKET_NEWS_FEEDS);
    const feeds = payload.feedSlug
        ? allFeeds.filter((f) => f.slug === payload.feedSlug)
        : [...allFeeds];

    let fetched = 0;
    let upserted = 0;

    for (const feed of feeds) {
        let items;
        try {
            items = await doFetch(feed.url, { maxItems: MAX_ITEMS_PER_FEED });
        } catch (err) {
            // Fail-soft: one dead feed never fails the batch.
            logger.warn('market-news-pull: feed fetch failed', {
                component: COMPONENT,
                feed: feed.slug,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }
        fetched += items.length;

        for (const raw of items) {
            const title = sanitizePlainText(raw.title).slice(0, TITLE_MAX);
            if (!title) continue; // sanitised-away title ⇒ skip
            const summary = raw.summary
                ? sanitizePlainText(raw.summary).slice(0, SUMMARY_MAX) || null
                : null;
            const category = categorize(title, summary, feed.defaultCategory);

            // Scheme-check what a third party gave us, at INGEST.
            //
            // `raw.url` is rendered as `<a href target="_blank">` on the News
            // tab, and `raw.imageUrl` is stored "for later" and rendered by
            // nobody yet — which is exactly why the check belongs here rather
            // than at the one render site that exists today. React 19 rewrites
            // a `javascript:` href and the CSP carries no `unsafe-inline`, so
            // this is not the last line of defence; what it stops reaching the
            // table is `http://` (a downgrade out of an HTTPS app) and every
            // other scheme an RSS feed can put in a `<link>`.
            //
            // An item with an unusable link is skipped rather than stored
            // linkless: the whole card is an anchor.
            if (!isHttpUrl(raw.url)) continue;
            const imageUrl = isHttpUrl(raw.imageUrl) ? raw.imageUrl : null;

            const hash = guidHash(feed.slug, raw.guid);

            // Idempotent upsert on the natural dedupe key (a WRITE in the loop —
            // the N+1 guard is about READS; mirrors market-prices-pull's point
            // upsert loop).
            await db.marketNewsItem.upsert({
                where: { guidHash: hash },
                create: {
                    source: feed.slug,
                    category,
                    title,
                    summary,
                    url: raw.url,
                    imageUrl,
                    publishedAt: raw.publishedAt,
                    guidHash: hash,
                },
                update: {
                    category,
                    title,
                    summary,
                    url: raw.url,
                    imageUrl,
                    publishedAt: raw.publishedAt,
                    fetchedAt: now,
                },
            });
            upserted += 1;
        }
    }

    // Prune the tail so the global table stays bounded.
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
    const { count: pruned } = await db.marketNewsItem.deleteMany({
        where: { publishedAt: { lt: cutoff } },
    });

    logger.info('market-news-pull: complete', {
        component: COMPONENT,
        feeds: feeds.length,
        fetched,
        upserted,
        pruned,
    });

    return { feeds: feeds.length, fetched, upserted, pruned };
}
