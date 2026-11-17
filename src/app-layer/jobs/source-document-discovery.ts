/**
 * Find NEW documents on МЗХ's listing pages and email the owner about them —
 * agri-saas#3146, second slice (the server half of agrent-ios#639: "a cron job
 * for querying the МЗХ for new series content every day").
 *
 * In `jobs/` for `source-document-watch`'s reason: there is no farm, no
 * `RequestContext` and no policy to check — a publication is a global fact.
 *
 * ## Baseline first, then only what is new
 *
 * The first time a listing is read, everything already on it is recorded as
 * `baseline` and NOT announced: switching discovery on must not mail the owner
 * every bulletin back to 2017. From the second read on, a URL not yet recorded
 * is new. A listing is "first read" when it has no rows at all — so a listing
 * added to `MZH_LISTINGS` later baselines on its own first run too.
 *
 * ## The email is sent before anything is stamped
 *
 * `notifiedAt` is written only after `sendEmail` resolved, for
 * `notice-triage-alert`'s reason: a row marked notified on a failed send
 * removes the news from the only place it was waiting. With no address
 * configured nothing is sent and nothing is stamped, so setting the address
 * later announces what was found meanwhile.
 *
 * ## Zero must never be ambiguous
 *
 * A listing that cannot be fetched, or that parses to NO links, is reported
 * by name: every listing carried 10–12 documents when located, so a zero is a
 * changed page, not a quiet day. "Nothing new" is said only beside the count
 * of listings that were actually read.
 */
import { env } from '@/env';
import { translateFor } from '@/lib/i18n/server-messages';
import { RECIPIENT_FALLBACK_LOCALE } from '@/lib/email/recipient-locale';
import { sendEmail } from '@/lib/mailer';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { fetchPublicUrl } from '@/lib/security/safe-fetch';
import {
    MZH_BASE,
    MZH_LISTINGS,
    listNewsItems,
    listPdfLinks,
    newsSeries,
    type ListedDocument,
    type MzhListing,
} from '@/lib/sources/mzh-listings';

/** News pages read per run: МЗХ posts several items a day, ten to a page. */
export const NEWS_PAGES = 3;
const FETCH_TIMEOUT_MS = 30_000;
/** Rows named in one email; the rest are counted. */
const NAMED_LIMIT = 40;
/** Bound on the per-listing read of known URLs (`take:`, D2). */
const KNOWN_URLS_TAKE = 5_000;

export interface DiscoveryOptions {
    fetchImpl?: typeof fetchPublicUrl;
    now?: Date;
}

export interface ListingOutcome {
    readonly listing: string;
    readonly status: 'read' | 'unreachable' | 'empty';
    readonly listed: number;
    readonly baselined: number;
    readonly found: number;
    readonly detail?: string;
}

export interface DiscoveryResult {
    readonly listings: ListingOutcome[];
    readonly found: number;
    readonly notified: number;
    readonly mail: 'sent' | 'nothing-new' | 'no-address' | 'failed';
}

async function fetchHtml(url: string, opts: DiscoveryOptions): Promise<string | { failure: string }> {
    try {
        const res = await (opts.fetchImpl ?? fetchPublicUrl)(url, {
            method: 'GET',
            timeoutMs: FETCH_TIMEOUT_MS,
            headers: { Accept: 'text/html' },
        });
        if (!res.ok) return { failure: `HTTP ${res.status}` };
        return await res.text();
    } catch (err) {
        return { failure: err instanceof Error ? err.message : String(err) };
    }
}

/** A listing's documents with the series each belongs to; null when unreadable. */
async function readListing(
    listing: MzhListing,
    opts: DiscoveryOptions,
): Promise<{ docs: Array<ListedDocument & { series: string }>; listed: number } | { failure: string }> {
    const base = `${MZH_BASE}${listing.path}`;
    if (listing.kind === 'pdf') {
        const html = await fetchHtml(base, opts);
        if (typeof html !== 'string') return html;
        const docs = listPdfLinks(html, base);
        return { docs: docs.map((d) => ({ ...d, series: listing.key })), listed: docs.length };
    }
    const all: ListedDocument[] = [];
    for (let page = 1; page <= NEWS_PAGES; page += 1) {
        const url = page === 1 ? base : `${base}?page=${page}`;
        const html = await fetchHtml(url, opts);
        if (typeof html !== 'string') {
            // The first page is the listing; a later page failing costs only
            // the older items, which earlier runs have already seen.
            if (page === 1) return html;
            break;
        }
        all.push(...listNewsItems(html, base));
    }
    const docs = all.flatMap((d) => {
        const series = newsSeries(d.title ?? '');
        return series ? [{ ...d, series }] : [];
    });
    // `listed` counts every news item read, matched or not: it is the
    // positive control that the page still parses.
    return { docs, listed: all.length };
}

export async function runSourceDocumentDiscovery(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
    const listings: ListingOutcome[] = [];
    const listingUrls = MZH_LISTINGS.map((l) => `${MZH_BASE}${l.path}`);

    // Both reads hoisted out of the per-listing loop (D1): which listings have
    // been read before, and every URL already recorded for them.
    //
    // "First read" is a fact about the LISTING (`SourceListingRead`), not about
    // its rows: a news list read with no matching item leaves no row, and
    // judging by rows would baseline the next real order silently.
    const readBefore = new Set(
        (await prisma.sourceListingRead.findMany({
            where: { listingUrl: { in: listingUrls } },
            select: { listingUrl: true },
            take: listingUrls.length,
        })).map((r) => r.listingUrl),
    );
    const knownByListing = new Map<string, Set<string>>();
    for (const row of await prisma.sourceDocumentDiscovery.findMany({
        where: { listingUrl: { in: listingUrls } },
        select: { url: true, listingUrl: true },
        take: KNOWN_URLS_TAKE,
    })) {
        const set = knownByListing.get(row.listingUrl) ?? new Set<string>();
        set.add(row.url);
        knownByListing.set(row.listingUrl, set);
    }

    for (const listing of MZH_LISTINGS) {
        const listingUrl = `${MZH_BASE}${listing.path}`;
        const read = await readListing(listing, opts);
        if ('failure' in read) {
            listings.push({ listing: listing.key, status: 'unreachable', listed: 0, baselined: 0, found: 0, detail: read.failure });
            continue;
        }
        if (read.listed === 0) {
            listings.push({ listing: listing.key, status: 'empty', listed: 0, baselined: 0, found: 0 });
            continue;
        }

        const firstRead = !readBefore.has(listingUrl);
        const seen = knownByListing.get(listingUrl) ?? new Set<string>();
        const fresh = read.docs.filter((d) => !seen.has(d.url));
        if (fresh.length > 0) {
            await prisma.sourceDocumentDiscovery.createMany({
                data: fresh.map((d) => ({
                    url: d.url,
                    series: d.series,
                    listingUrl,
                    title: d.title,
                    baseline: firstRead,
                })),
                // The same PDF can sit on two listings; the first one keeps it.
                skipDuplicates: true,
            });
        }
        await prisma.sourceListingRead.upsert({
            where: { listingUrl },
            create: { listingUrl },
            update: { lastReadAt: opts.now ?? new Date() },
        });
        listings.push({
            listing: listing.key,
            status: 'read',
            listed: read.listed,
            baselined: firstRead ? fresh.length : 0,
            found: firstRead ? 0 : fresh.length,
        });
    }

    const found = listings.reduce((n, l) => n + l.found, 0);
    const pending = await prisma.sourceDocumentDiscovery.findMany({
        where: { baseline: false, notifiedAt: null },
        orderBy: { firstSeenAt: 'asc' },
        take: KNOWN_URLS_TAKE,
        select: { id: true, url: true, series: true, title: true },
    });

    let mail: DiscoveryResult['mail'] = 'nothing-new';
    let notified = 0;
    const to = env.MZH_WATCH_NOTIFY_EMAIL;
    if (pending.length > 0 && !to) {
        mail = 'no-address';
        logger.warn('mzh-discovery.no_contact_address', {
            component: 'mzh-discovery',
            pending: pending.length,
            hint: 'Set MZH_WATCH_NOTIFY_EMAIL on the VM; nothing is stamped until it is set.',
        });
    } else if (pending.length > 0 && to) {
        const locale = RECIPIENT_FALLBACK_LOCALE;
        const subject = await translateFor(locale, 'mzhDiscovery.subject', { count: pending.length });
        const intro = await translateFor(locale, 'mzhDiscovery.intro', { count: pending.length });
        const lines: string[] = [];
        for (const row of pending.slice(0, NAMED_LIMIT)) {
            const series = await translateFor(locale, `mzhDiscovery.series.${row.series}`);
            lines.push(`• ${series}: ${row.title ?? row.url}`, `  ${row.url}`);
        }
        const more = pending.length > NAMED_LIMIT
            ? [await translateFor(locale, 'mzhDiscovery.more', { count: pending.length - NAMED_LIMIT })]
            : [];
        try {
            await sendEmail({
                to,
                subject,
                text: [intro, '', ...lines, ...more].join('\n'),
                purpose: 'mzh-discovery',
            });
            const stamped = await prisma.sourceDocumentDiscovery.updateMany({
                where: { id: { in: pending.map((p) => p.id) } },
                data: { notifiedAt: opts.now ?? new Date() },
            });
            notified = stamped.count;
            mail = 'sent';
        } catch (err) {
            mail = 'failed';
            logger.error('mzh-discovery.send_failed', {
                component: 'mzh-discovery',
                pending: pending.length,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // One line with every denominator: which listings were read, which were
    // not and why, what was baselined, found and announced.
    const broken = listings.filter((l) => l.status !== 'read');
    const log = broken.length > 0 ? logger.warn.bind(logger) : logger.info.bind(logger);
    log('mzh-discovery.run', {
        component: 'mzh-discovery',
        listingsRead: listings.length - broken.length,
        listingsTotal: listings.length,
        broken: broken.map((l) => `${l.listing}:${l.status}${l.detail ? `(${l.detail})` : ''}`).join(',') || 'none',
        baselined: listings.reduce((n, l) => n + l.baselined, 0),
        found,
        notified,
        mail,
    });

    return { listings, found, notified, mail };
}
