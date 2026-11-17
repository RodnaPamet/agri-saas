/**
 * `source-document-discovery` — agri-saas#3146, second slice: МЗХ's listing
 * pages, daily; the first read baselines, later reads announce what is new by
 * email (owner, 2026-11-17), and nothing is stamped before a send succeeded.
 */
type Row = {
    id: string; url: string; series: string; listingUrl: string; title: string | null;
    baseline: boolean; firstSeenAt: Date; notifiedAt: Date | null;
};
const store = new Map<string, Row>();
const listingsRead = new Set<string>();
let nextId = 0;

jest.mock('@/lib/prisma', () => ({
    prisma: {
        sourceListingRead: {
            findMany: async ({ where, take }: { where: { listingUrl: { in: string[] } }; take?: number }) => {
                expect(typeof take).toBe('number');
                return where.listingUrl.in.filter((u) => listingsRead.has(u)).map((listingUrl) => ({ listingUrl }));
            },
            upsert: async ({ where }: { where: { listingUrl: string } }) => {
                listingsRead.add(where.listingUrl);
                return { listingUrl: where.listingUrl };
            },
        },
        sourceDocumentDiscovery: {
            findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
                expect(typeof take).toBe('number');
                const rows = [...store.values()];
                if ('listingUrl' in where) {
                    const urls = (where.listingUrl as { in: string[] }).in;
                    return rows.filter((r) => urls.includes(r.listingUrl));
                }
                return rows
                    .filter((r) => r.baseline === where.baseline && r.notifiedAt === null)
                    .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
            },
            createMany: async ({ data }: { data: Array<Omit<Row, 'id' | 'firstSeenAt' | 'notifiedAt'>> }) => {
                let count = 0;
                for (const d of data) {
                    if (store.has(d.url)) continue;
                    store.set(d.url, { ...d, id: `d${++nextId}`, firstSeenAt: new Date(nextId), notifiedAt: null });
                    count += 1;
                }
                return { count };
            },
            updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { notifiedAt: Date } }) => {
                let count = 0;
                for (const r of store.values()) if (where.id.in.includes(r.id)) { r.notifiedAt = data.notifiedAt; count += 1; }
                return { count };
            },
        },
    },
}));

const sendEmail = jest.fn();
jest.mock('@/lib/mailer', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

let notifyEmail: string | undefined = 'owner@example.test';
jest.mock('@/env', () => {
    // A Proxy over the real env: `@t3-oss/env-nextjs` has no own keys, so a
    // spread would empty it (see p5-8-triage-alert).
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        ...actual,
        env: new Proxy(actual.env, {
            get(target, prop, receiver) {
                if (prop === 'MZH_WATCH_NOTIFY_EMAIL') return notifyEmail;
                return Reflect.get(target, prop, receiver);
            },
        }),
    };
});

const warn = jest.fn();
const info = jest.fn();
const error = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        warn: (...a: unknown[]) => warn(...a),
        info: (...a: unknown[]) => info(...a),
        error: (...a: unknown[]) => error(...a),
    },
}));

import { runSourceDocumentDiscovery } from '@/app-layer/jobs/source-document-discovery';
import { MZH_BASE } from '@/lib/sources/mzh-listings';

const pdf = (path: string, text: string) => `<a href="/media/filer_public/${path}.pdf">${text}</a>`;
const news = (slug: string, title: string) => `<a href="/bg/press-center/novini/${slug}/">${title}</a>`;

/** The site as a map from path to HTML; anything absent answers 404. */
let site: Record<string, string>;
const fetchImpl = (async (url: string) => {
    const path = url.replace(MZH_BASE, '');
    const html = site[path];
    return html === undefined
        ? new Response('not found', { status: 404 })
        : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
}) as never;

const OA = '/bg/ikonomicheski-analizi/tekushi-operativni-analizi-za-osnovni-zemedelski-kulturi/';
const TK = '/bg/sektori/rastenievadstvo/tehnologichni-karti/';
const AD = '/bg/politiki-i-programi/otcheti-i-dokladi/agraren-doklad/';
const NEWS = '/bg/press-center/novini/';

function baseSite() {
    site = {
        [OA]: pdf('2026/11/11/operativen_analiz_2026-11-11', 'Оперативен анализ към 11.11.2026'),
        [TK]: pdf('2026/09/01/tk_vineni_lozia', 'Технологични карти — винени лозя'),
        [AD]: pdf('2025/12/08/ad_2025', 'Аграрен доклад 2025'),
        [NEWS]: news('ministr', 'Министър: разговор за ОСП'),
        [`${NEWS}?page=2`]: news('ovce', 'Определена е ставката за преходната национална помощ за овце-майки'),
        [`${NEWS}?page=3`]: '',
    };
}

beforeEach(() => {
    store.clear();
    listingsRead.clear();
    nextId = 0;
    notifyEmail = 'owner@example.test';
    [sendEmail, warn, info, error].forEach((m) => m.mockReset());
    sendEmail.mockResolvedValue(undefined);
    baseSite();
});

it('the FIRST read baselines what is already listed and announces nothing', async () => {
    const r = await runSourceDocumentDiscovery({ fetchImpl });
    expect(r.listings.map((l) => [l.listing, l.status, l.baselined, l.found])).toEqual([
        ['operativen-analiz', 'read', 1, 0],
        ['technology-card', 'read', 1, 0],
        ['agraren-doklad', 'read', 1, 0],
        // Two news items read, neither a watched series: read, nothing recorded.
        ['news', 'read', 0, 0],
    ]);
    expect(r.mail).toBe('nothing-new');
    expect(sendEmail).not.toHaveBeenCalled();
    expect([...store.values()].every((row) => row.baseline)).toBe(true);
});

it('a later read emails ONE message naming what is new, then stamps it', async () => {
    await runSourceDocumentDiscovery({ fetchImpl });
    site[TK] += pdf('2026/11/17/tk_zelenchuci_2026', 'Технологични карти — зеленчуци 2026');
    site[NEWS] += news('stavki-2026', 'Определени са ставките за обвързаното подпомагане за Кампания 2026');

    const r = await runSourceDocumentDiscovery({ fetchImpl, now: new Date('2026-11-18T05:10:00Z') });
    expect(r.found).toBe(2);
    expect(r.notified).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0] as { to: string; subject: string; text: string; purpose: string };
    expect(msg).toMatchObject({ to: 'owner@example.test', purpose: 'mzh-discovery' });
    expect(msg.subject).toBe('МЗХ: нови документи (2)');
    expect(msg.text).toContain('Технологична карта: Технологични карти — зеленчуци 2026');
    expect(msg.text).toContain('Обвързано подпомагане: Определени са ставките за обвързаното подпомагане за Кампания 2026');
    expect(msg.text).toContain(`${MZH_BASE}/media/filer_public/2026/11/17/tk_zelenchuci_2026.pdf`);

    // Nothing is announced twice.
    sendEmail.mockClear();
    const again = await runSourceDocumentDiscovery({ fetchImpl });
    expect(again.mail).toBe('nothing-new');
    expect(sendEmail).not.toHaveBeenCalled();
});

it('a failed send stamps nothing, and the next run announces it', async () => {
    await runSourceDocumentDiscovery({ fetchImpl });
    site[AD] += pdf('2026/12/08/ad_2026', 'Аграрен доклад 2026');
    sendEmail.mockRejectedValueOnce(new Error('smtp refused'));

    const failed = await runSourceDocumentDiscovery({ fetchImpl });
    expect(failed).toMatchObject({ found: 1, notified: 0, mail: 'failed' });
    expect(error).toHaveBeenCalledWith('mzh-discovery.send_failed', expect.anything());

    const next = await runSourceDocumentDiscovery({ fetchImpl });
    expect(next).toMatchObject({ found: 0, notified: 1, mail: 'sent' });
});

it('with no address nothing is sent or stamped, and the log says why', async () => {
    await runSourceDocumentDiscovery({ fetchImpl });
    site[OA] += pdf('2026/11/18/operativen_analiz_2026-11-18', 'Оперативен анализ към 18.11.2026');
    notifyEmail = undefined;
    const r = await runSourceDocumentDiscovery({ fetchImpl });
    expect(r).toMatchObject({ found: 1, notified: 0, mail: 'no-address' });
    expect(warn).toHaveBeenCalledWith('mzh-discovery.no_contact_address', expect.objectContaining({ pending: 1 }));
    expect([...store.values()].every((row) => row.notifiedAt === null)).toBe(true);
});

it('a listing that fails or parses to nothing is named, and the others are still read', async () => {
    delete site[TK];
    site[AD] = '<div>Страницата е преместена</div>';
    const r = await runSourceDocumentDiscovery({ fetchImpl });
    expect(r.listings.map((l) => [l.listing, l.status])).toEqual([
        ['operativen-analiz', 'read'],
        ['technology-card', 'unreachable'],
        ['agraren-doklad', 'empty'],
        ['news', 'read'],
    ]);
    expect(warn).toHaveBeenCalledWith('mzh-discovery.run', expect.objectContaining({
        listingsRead: 2,
        listingsTotal: 4,
        broken: expect.stringContaining('technology-card:unreachable(HTTP 404)'),
    }));
    // A listing that was never read has not been baselined: when it comes
    // back, its first good read baselines rather than announcing everything.
    expect([...store.values()].some((row) => row.series === 'technology-card')).toBe(false);
});
