/**
 * Agri-news feed client — fetch + parse RSS 2.0 / Atom into normalised items.
 *
 * PURE parsing (no DB, no sanitisation) — the `news-pull` job sanitises
 * (Epic C.5 `sanitizePlainText`), caps, and persists. Kept split like the
 * SoilGrids client so unit tests can feed canned XML with no network.
 *
 * LEGAL FRAME: we read ONLY title + link + short description + optional image
 * from each feed and link OUT to the publisher — never full-text. Feeds that
 * 403 a server User-Agent (agri.bg / fermer.bg / sinor.bg) are NOT hardcoded;
 * agroportal.bg price content is a partner exclusive and is never fetched.
 *
 * Contract (mirrors soilgrids-client):
 *   • one GET per feed URL with an AbortController timeout,
 *   • a custom User-Agent identifying the app,
 *   • a throw on any non-2xx (the caller isolates per-feed errors),
 *   • RSS 2.0 `<item>` OR Atom `<entry>` flattened into `ParsedNewsItem`.
 *
 * @module lib/market/news-feed-client
 */
import { DOMParser } from '@xmldom/xmldom';

/** Default per-feed fetch timeout. */
const FETCH_TIMEOUT_MS = 15_000;

/** Custom UA — identifies the aggregator so publishers can attribute traffic. */
export const NEWS_FEED_USER_AGENT =
    'AgrentNewsBot/1.0 (+https://agrent.bg; agri-news RSS aggregator)';

/** One normalised feed entry — raw text (job sanitises + caps before persist). */
export interface ParsedNewsItem {
    /** Headline (raw — may contain HTML entities; the job sanitises). */
    title: string;
    /** Absolute article URL at the publisher. */
    url: string;
    /** Short excerpt (raw — may be empty; the job sanitises + caps). */
    snippet: string;
    /** Thumbnail URL, or null when the entry carries no image. */
    imageUrl: string | null;
    /** Publication instant, or null when the feed omits / mangles the date. */
    publishedAt: Date | null;
}

/** A parsed feed: its channel/source label + the entries. */
export interface ParsedFeed {
    /** Channel `<title>` (RSS) / feed `<title>` (Atom), trimmed — else ''. */
    sourceLabel: string;
    items: ParsedNewsItem[];
}

export interface FetchNewsFeedOptions {
    /** Fetch timeout (ms). */
    timeoutMs?: number;
    /** User-Agent override (defaults to NEWS_FEED_USER_AGENT). */
    userAgent?: string;
}

// ── XML helpers ────────────────────────────────────────────────────────

function firstText(el: Element, tag: string): string {
    const nodes = el.getElementsByTagName(tag);
    const node = nodes.length > 0 ? nodes.item(0) : null;
    return node?.textContent?.trim() ?? '';
}

/** Parse a date string leniently. `new Date()` handles RFC-822 + ISO-8601. */
function parseDate(raw: string): Date | null {
    const s = raw.trim();
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Pull an image URL from an RSS `<item>` (enclosure or media:*), else null. */
function rssImage(item: Element): string | null {
    // <enclosure url="…" type="image/*" />
    const enclosures = item.getElementsByTagName('enclosure');
    for (let i = 0; i < enclosures.length; i++) {
        const enc = enclosures.item(i);
        if (!enc) continue;
        const url = enc.getAttribute('url');
        const type = enc.getAttribute('type') ?? '';
        if (url && (type.startsWith('image/') || type === '')) return url;
    }
    // <media:content url="…" medium="image"> / <media:thumbnail url="…">
    for (const tag of ['media:content', 'media:thumbnail']) {
        const nodes = item.getElementsByTagName(tag);
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes.item(i);
            const url = node?.getAttribute('url');
            if (url) return url;
        }
    }
    return null;
}

/** Resolve an Atom `<entry>`'s alternate link (article) + enclosure (image). */
function atomLinks(entry: Element): { url: string; imageUrl: string | null } {
    const links = entry.getElementsByTagName('link');
    let alternate = '';
    let firstHref = '';
    let imageUrl: string | null = null;
    for (let i = 0; i < links.length; i++) {
        const link = links.item(i);
        if (!link) continue;
        const href = link.getAttribute('href') ?? '';
        if (!href) continue;
        const rel = link.getAttribute('rel') ?? '';
        const type = link.getAttribute('type') ?? '';
        if (!firstHref) firstHref = href;
        if (rel === 'alternate' || rel === '') alternate = alternate || href;
        if (rel === 'enclosure' && (type.startsWith('image/') || type === '')) {
            imageUrl = imageUrl ?? href;
        }
    }
    return { url: alternate || firstHref, imageUrl };
}

// ── Parsing ────────────────────────────────────────────────────────────

/**
 * Parse an RSS 2.0 or Atom feed document into a `ParsedFeed`. PURE — no
 * network, no DB, no sanitisation. Tolerates an empty `<description>`,
 * `http` links, missing images, and unparseable dates (→ null). Never
 * throws on a malformed document: unknown / broken shapes yield an empty
 * item list so one bad feed can't kill the pull run.
 */
export function parseFeedXml(xml: string): ParsedFeed {
    let doc: Document;
    try {
        // xmldom logs to onError; swallow to avoid noisy console on odd feeds.
        doc = new DOMParser({
            onError: () => {
                /* tolerate malformed markup — we read what parsed */
            },
        }).parseFromString(xml, 'text/xml') as unknown as Document;
    } catch {
        return { sourceLabel: '', items: [] };
    }
    if (!doc || !doc.documentElement) return { sourceLabel: '', items: [] };

    const root = doc.documentElement;
    const items: ParsedNewsItem[] = [];

    // RSS 2.0 — <item> elements (channel title is the source label).
    const rssItems = doc.getElementsByTagName('item');
    if (rssItems.length > 0) {
        const channels = doc.getElementsByTagName('channel');
        const channel = channels.length > 0 ? channels.item(0) : null;
        const sourceLabel = channel ? firstText(channel, 'title') : '';
        for (let i = 0; i < rssItems.length; i++) {
            const item = rssItems.item(i);
            if (!item) continue;
            const url = firstText(item, 'link');
            const title = firstText(item, 'title');
            if (!url || !title) continue;
            items.push({
                title,
                url,
                snippet: firstText(item, 'description'),
                imageUrl: rssImage(item),
                publishedAt: parseDate(firstText(item, 'pubDate')),
            });
        }
        return { sourceLabel, items };
    }

    // Atom — <entry> elements (feed title is the source label).
    const entries = doc.getElementsByTagName('entry');
    if (entries.length > 0) {
        // Feed title: the first <title> that is NOT inside an <entry>.
        let sourceLabel = '';
        const titles = root.getElementsByTagName('title');
        const firstTitle = titles.length > 0 ? titles.item(0) : null;
        if (firstTitle) sourceLabel = firstTitle.textContent?.trim() ?? '';
        for (let i = 0; i < entries.length; i++) {
            const entry = entries.item(i);
            if (!entry) continue;
            const { url, imageUrl } = atomLinks(entry);
            const title = firstText(entry, 'title');
            if (!url || !title) continue;
            const summary = firstText(entry, 'summary') || firstText(entry, 'content');
            const published =
                firstText(entry, 'published') || firstText(entry, 'updated');
            items.push({
                title,
                url,
                snippet: summary,
                imageUrl,
                publishedAt: parseDate(published),
            });
        }
        return { sourceLabel, items };
    }

    return { sourceLabel: '', items: [] };
}

/**
 * Fetch + parse one feed URL. Throws on a non-2xx or network/timeout error
 * so the `news-pull` job can isolate the failure per feed and continue.
 */
export async function fetchNewsFeed(
    feedUrl: string,
    opts: FetchNewsFeedOptions = {},
): Promise<ParsedFeed> {
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(),
        opts.timeoutMs ?? FETCH_TIMEOUT_MS,
    );

    let response: Response;
    try {
        response = await fetch(feedUrl, {
            method: 'GET',
            headers: {
                Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
                'User-Agent': opts.userAgent ?? NEWS_FEED_USER_AGENT,
            },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(`news feed ${feedUrl} returned ${response.status}`);
    }

    const xml = await response.text();
    return parseFeedXml(xml);
}
