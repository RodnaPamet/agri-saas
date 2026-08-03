/**
 * news-pull — aggregate agri-news headlines into the GLOBAL MarketNewsItem cache.
 *
 * Reads `MARKET_NEWS_FEEDS` (comma-separated RSS/Atom URLs). For each feed:
 *   1. fetch + parse (RSS 2.0 `<item>` OR Atom `<entry>`) — per-feed try/catch
 *      so one dead / 403 feed never kills the run,
 *   2. sanitise title + snippet with `sanitizePlainText` (Epic C.5 — RSS is
 *      untrusted remote HTML) and cap the snippet at ~300 chars,
 *   3. accept only `http(s)` article URLs (drops `javascript:` etc.),
 *   4. upsert on `urlHash` = sha256(url) so a re-run never duplicates a row.
 * Finally prune items older than 90 days.
 *
 * MarketNewsItem is a GLOBAL cache table (no tenantId / no RLS, like
 * MarketPriceSeries / SoilSample), so the ordinary `prisma` singleton (DB
 * superuser, matches `superuser_bypass`) reads + writes it directly. No
 * per-tenant context is needed.
 *
 * LEGAL: title + snippet + source + link ONLY, always linking OUT to the
 * publisher — no full-text republication, no paywalled/partner scraping.
 *
 * @module jobs/news-pull
 */
import { createHash } from 'node:crypto';

import prisma from '@/lib/prisma';
import { env } from '@/env';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';
import {
    fetchNewsFeed,
    type ParsedFeed,
} from '@/lib/market/news-feed-client';
import type { NewsPullPayload } from './types';

const COMPONENT = 'news-pull';

/** Snippet cap — legal frame (short excerpt, never full text). */
export const NEWS_SNIPPET_MAX = 300;
/** Retention window — prune items older than this. */
const RETENTION_DAYS = 90;
/** Max items persisted per feed per run (defensive bound on a huge feed). */
const MAX_ITEMS_PER_FEED = 60;

/** The Prisma delegate this job touches (single global cache table). */
type NewsDbClient = {
    marketNewsItem: typeof prisma.marketNewsItem;
};

/** Injectable seams so tests drive the pull without real network / prod DB. */
export interface NewsPullDeps {
    /** Fetch override (defaults to the real `fetchNewsFeed`). */
    fetchFeed?: (feedUrl: string) => Promise<ParsedFeed>;
    /** DB client override (integration tests pass the test-DB client). */
    db?: NewsDbClient;
    /** Feed list override (defaults to env.MARKET_NEWS_FEEDS). */
    feeds?: string[];
}

export interface NewsPullResult {
    feeds: number;
    fetched: number;
    upserted: number;
    pruned: number;
    failedFeeds: number;
}

/** Parse the comma-separated env into a clean, de-duplicated URL list. */
export function parseFeedList(raw: string | undefined): string[] {
    if (!raw) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(',')) {
        const url = part.trim();
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push(url);
    }
    return out;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Accept only absolute http(s) URLs; reject javascript: / data: / relative. */
function isHttpUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

/** Cap a sanitised excerpt to the legal-frame length with a trailing ellipsis. */
function capSnippet(text: string): string {
    if (text.length <= NEWS_SNIPPET_MAX) return text;
    return `${text.slice(0, NEWS_SNIPPET_MAX - 1).trimEnd()}…`;
}

export async function runNewsPull(
    payload: NewsPullPayload = {},
    deps: NewsPullDeps = {},
): Promise<NewsPullResult> {
    const db = deps.db ?? prisma;
    const fetchFeed = deps.fetchFeed ?? fetchNewsFeed;
    const feeds = deps.feeds ?? parseFeedList(env.MARKET_NEWS_FEEDS);

    if (feeds.length === 0) {
        logger.info('news-pull: no feeds configured (MARKET_NEWS_FEEDS unset)', {
            component: COMPONENT,
        });
        return { feeds: 0, fetched: 0, upserted: 0, pruned: 0, failedFeeds: 0 };
    }

    let fetched = 0;
    let upserted = 0;
    let failedFeeds = 0;

    // Per-feed isolation: a dead / 403 / malformed feed logs + continues.
    for (const feedUrl of feeds) {
        let parsed: ParsedFeed;
        try {
            parsed = await fetchFeed(feedUrl);
        } catch (err) {
            failedFeeds += 1;
            logger.warn('news-pull: feed fetch failed', {
                component: COMPONENT,
                feedUrl,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        // Source attribution: sanitised channel title, else the feed host.
        const hostFallback = (() => {
            try {
                return new URL(feedUrl).hostname.replace(/^www\./, '');
            } catch {
                return feedUrl;
            }
        })();
        const feedSource =
            sanitizePlainText(parsed.sourceLabel).trim() || hostFallback;

        const items = parsed.items.slice(0, MAX_ITEMS_PER_FEED);
        for (const item of items) {
            if (!isHttpUrl(item.url)) continue;
            const title = capSnippet(sanitizePlainText(item.title).trim());
            if (!title) continue;
            const snippet = capSnippet(sanitizePlainText(item.snippet).trim());
            const urlHash = sha256(item.url);
            const publishedAt = item.publishedAt ?? new Date();
            const data = {
                feedSource,
                title,
                snippet,
                url: item.url,
                imageUrl: isHttpUrl(item.imageUrl ?? '') ? item.imageUrl : null,
                publishedAt,
            };
            // WRITE inside the loop — not a Prisma read (N+1 rule is about
            // reads). Upsert keyed on the unique urlHash → fully idempotent.
            await db.marketNewsItem.upsert({
                where: { urlHash },
                create: { urlHash, ...data },
                update: { ...data, fetchedAt: new Date() },
            });
            upserted += 1;
        }
        fetched += items.length;
    }

    // Retention: drop items older than the window.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count: pruned } = await db.marketNewsItem.deleteMany({
        where: { publishedAt: { lt: cutoff } },
    });

    logger.info('news-pull: complete', {
        component: COMPONENT,
        feeds: feeds.length,
        fetched,
        upserted,
        pruned,
        failedFeeds,
    });

    return { feeds: feeds.length, fetched, upserted, pruned, failedFeeds };
}
