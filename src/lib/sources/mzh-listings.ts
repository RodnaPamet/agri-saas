/**
 * The МЗХ pages that LIST each publication series — agri-saas#3146, second
 * slice (agrent-ios#639: "querying the МЗХ for new series content every day").
 *
 * ## Read off a listing page, never constructed
 *
 * #3136 measured that МЗХ document URLs cannot be built: the directory is the
 * publish date, the filename the document's own date, they differ, and some
 * carry a random suffix. So each series is found where МЗХ itself lists it.
 * Located 2026-11-17, each checked to return its documents:
 *
 * | series            | page                                                     |
 * |-------------------|----------------------------------------------------------|
 * | operativen-analiz | /bg/ikonomicheski-analizi/tekushi-operativni-analizi-…/  |
 * | technology-card   | /bg/sektori/rastenievadstvo/tehnologichni-karti/         |
 * | agraren-doklad    | /bg/politiki-i-programi/otcheti-i-dokladi/agraren-doklad/ |
 * | (news)            | /bg/press-center/novini/  — coupled-support rate orders  |
 * |                   |   and integrated-production guides, by TITLE             |
 *
 * The integrated-production guides and the coupled-support orders have no
 * listing page of their own that could be found; МЗХ announces both as news
 * («Определени са ставките за обвързаното подпомагане…»), so the news list is
 * read and a TITLE decides the series. A news item matching no series is not
 * recorded at all — this watches publications, not the press office.
 *
 * ## A listing that parses to NOTHING is a fault, not a quiet day
 *
 * Every listing carries documents (10–12 PDFs each when located), so zero
 * links means the page changed shape. The job reports that loudly rather
 * than recording "nothing new" — the `Agricultural_Land` → `Physical_Blocks`
 * rename (#3165) is what a silent zero from this publisher looks like.
 */

export const MZH_BASE = 'https://www.mzh.government.bg';

export interface MzhListing {
    /** Stable key for the listing; also the series for a `pdf` listing. */
    readonly key: string;
    readonly path: string;
    readonly kind: 'pdf' | 'news';
}

export const MZH_LISTINGS: readonly MzhListing[] = [
    {
        key: 'operativen-analiz',
        path: '/bg/ikonomicheski-analizi/tekushi-operativni-analizi-za-osnovni-zemedelski-kulturi/',
        kind: 'pdf',
    },
    { key: 'technology-card', path: '/bg/sektori/rastenievadstvo/tehnologichni-karti/', kind: 'pdf' },
    { key: 'agraren-doklad', path: '/bg/politiki-i-programi/otcheti-i-dokladi/agraren-doklad/', kind: 'pdf' },
    { key: 'news', path: '/bg/press-center/novini/', kind: 'news' },
];

/**
 * A news TITLE to the series it announces, or null. Both words must be there:
 * «ставк…» alone matches the transitional national aid for sheep, which is
 * not a coupled-support order.
 */
export const NEWS_SERIES: ReadonlyArray<{ series: string; test: (title: string) => boolean }> = [
    { series: 'coupled-support', test: (t) => /ставк/i.test(t) && /обвърза/i.test(t) },
    { series: 'integrated-production', test: (t) => /интегрирано\s+производство/i.test(t) },
    { series: 'technology-card', test: (t) => /технологичн\S*\s+карт/i.test(t) },
    { series: 'agraren-doklad', test: (t) => /аграрен\s+доклад/i.test(t) },
];

export function newsSeries(title: string): string | null {
    return NEWS_SERIES.find((s) => s.test(title))?.series ?? null;
}

export interface ListedDocument {
    readonly url: string;
    readonly title: string | null;
}

const decode = (s: string): string =>
    s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&laquo;/g, '«')
        .replace(/&raquo;/g, '»')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();

function absolute(href: string, pageUrl: string): string | null {
    try {
        const u = new URL(href, pageUrl);
        // МЗХ's own documents only: a link to another site is not its series.
        if (u.hostname !== new URL(MZH_BASE).hostname && u.hostname !== 'mzh.government.bg') return null;
        u.hash = '';
        return u.toString();
    } catch {
        return null;
    }
}

/** Every PDF the page links to, once each, with its link text. */
export function listPdfLinks(html: string, pageUrl: string): ListedDocument[] {
    const out = new Map<string, ListedDocument>();
    for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = absolute(m[1] as string, pageUrl);
        if (!url || out.has(url)) continue;
        const text = decode(m[2] as string);
        out.set(url, { url, title: text === '' ? null : text });
    }
    return [...out.values()];
}

/** Every news item on a news-list page, once each, with its title. */
export function listNewsItems(html: string, pageUrl: string): ListedDocument[] {
    const out = new Map<string, ListedDocument>();
    for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*"(\/bg\/press-center\/novini\/[^"?#]+\/)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = absolute(m[1] as string, pageUrl);
        const text = decode(m[2] as string);
        if (!url || text === '') continue;
        // The same item is linked twice (image and title); keep the titled one.
        if (!out.has(url)) out.set(url, { url, title: text });
    }
    return [...out.values()];
}
