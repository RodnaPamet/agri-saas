/**
 * The citation watch — #3146, first slice of the server half of agrent-ios#639.
 *
 * The fetch is INJECTED and Prisma is a small IN-MEMORY STORE rather than a
 * call recorder, because the properties under test are about what SURVIVES
 * between runs: a flag must be sticky, must not re-stamp its date, and must
 * never consume the baseline it was raised against. A `jest.fn()` that only
 * records calls cannot express "and the second run saw what the first one
 * wrote", which is where every one of those properties lives.
 *
 * The write SHAPE is asserted too, directly — that an update flagging a change
 * carries no `sha256` key at all. That is the one assertion a reader should
 * check first: it is what "flag rather than silently overwrite" means in code,
 * and it is invisible in the returned counts.
 */
interface Row {
    id: string;
    url: string;
    citation: string;
    publisher: string;
    series: string | null;
    sha256: string;
    bytes: number;
    contentType: string | null;
    firstSeenAt: Date;
    lastCheckedAt: Date | null;
    lastStatus: string | null;
    changedAt: Date | null;
    changedSha256: string | null;
    changedBytes: number | null;
}

const store = new Map<string, Row>();
/** Every `data` object handed to `update`, in order — for shape assertions. */
const updates: { id: string; data: Record<string, unknown> }[] = [];
let nextId = 0;

jest.mock('@/lib/prisma', () => ({
    prisma: {
        sourceDocumentWatch: {
            findMany: async ({ where, take }: { where: { url: { in: string[] } }; take?: number }) => {
                // `take` is asserted rather than ignored: a bound nothing
                // checks is a bound that can be deleted without a test failing.
                expect(typeof take).toBe('number');
                return [...store.values()].filter((r) => where.url.in.includes(r.url));
            },
            create: async ({ data }: { data: Partial<Row> }) => {
                const row = {
                    id: `w${++nextId}`,
                    firstSeenAt: new Date(),
                    changedAt: null,
                    changedSha256: null,
                    changedBytes: null,
                    ...data,
                } as Row;
                store.set(row.url, row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                updates.push({ id: where.id, data });
                const row = [...store.values()].find((r) => r.id === where.id);
                if (!row) throw new Error(`no row ${where.id}`);
                Object.assign(row, data);
                return row;
            },
            count: async ({ where }: { where: { changedAt: { not: null } } }) => {
                expect(where.changedAt).toEqual({ not: null });
                return [...store.values()].filter((r) => r.changedAt !== null).length;
            },
        },
    },
}));

const cited = jest.fn();
jest.mock('@/lib/agro/calendar/load', () => ({
    citedSourceUrls: () => cited(),
}));

const warn = jest.fn();
const info = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a) },
}));

import { createHash } from 'node:crypto';

import {
    runSourceDocumentWatch,
    seriesForCitation,
    SERIES_BY_CITATION_PREFIX,
} from '@/app-layer/jobs/source-document-watch';

const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');

const OA = { key: 'mzh-oa-2026-09-02', publisher: 'МЗХ', url: 'https://www.mzh.government.bg/oa.pdf' };
const TK = { key: 'mzh-tk-wine-2026', publisher: 'МЗХ', url: 'https://www.mzh.government.bg/tk.pdf' };
const KWS = { key: 'kws-rapeseed-2024', publisher: 'KWS', url: 'https://mediamaster.kws.com/r.pdf' };

/** Serve named bodies per URL; a URL mapped to `null` is unreachable. */
function bodies(map: Record<string, string | null>) {
    return {
        fetchImpl: (async (url: string) => {
            const body = map[String(url)];
            if (body === null || body === undefined) throw new Error('ETIMEDOUT');
            const buf = Buffer.from(body);
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/pdf' }),
                arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            } as unknown as Response;
        }) as never,
    };
}

beforeEach(() => {
    store.clear();
    updates.length = 0;
    nextId = 0;
    cited.mockReset();
    warn.mockReset();
    info.mockReset();
});

describe('seriesForCitation', () => {
    it('classifies from the citation key, and refuses to guess', () => {
        expect(seriesForCitation('mzh-oa-2026-09-02')).toBe('operativen-analiz');
        expect(seriesForCitation('mzh-tk-wine-2026')).toBe('technology-card');
        expect(seriesForCitation('mzh-ip-2024')).toBe('integrated-production');
        expect(seriesForCitation('kws-rapeseed-2024')).toBeNull();
        expect(seriesForCitation('mzh-something-new')).toBeNull();
    });

    it('covers every citation the REAL calendar dataset carries today', () => {
        // Derived from the dataset, not from a list here: a new МЗХ series
        // cited by the calendar shows up as an unclassified key rather than
        // being silently labelled. The real module is required directly
        // because this file mocks it for every other test.
        const actual = jest.requireActual<typeof import('@/lib/agro/calendar/load')>(
            '@/lib/agro/calendar/load',
        );
        const all = actual.citedSourceUrls();
        const unclassified = all.filter((c) => seriesForCitation(c.key) === null);

        // [source-document-watch] cited=13 classified=12 unclassified=1
        // eslint-disable-next-line no-console
        console.log(
            `[source-document-watch] cited=${all.length} classified=${all.length - unclassified.length} unclassified=${unclassified.map((c) => c.key).join(',') || 'none'}`,
        );

        expect(all.length).toBeGreaterThanOrEqual(13);
        // The single unclassified citation today is the non-МЗХ seed sheet.
        // A FLOOR on what is classified, so an extraction that stopped
        // matching fails instead of passing over nothing.
        expect(all.length - unclassified.length).toBeGreaterThanOrEqual(12);
        expect(unclassified.every((c) => c.publisher !== 'МЗХ')).toBe(true);
    });

    it('CONTROL — the prefix table is non-empty, so the classifier can classify', () => {
        // Without this, an emptied table makes every assertion above about
        // `null` pass for the wrong reason.
        expect(SERIES_BY_CITATION_PREFIX.length).toBeGreaterThanOrEqual(3);
    });
});

describe('runSourceDocumentWatch', () => {
    it('mints a baseline row per citation on the first run', async () => {
        cited.mockReturnValue([OA, KWS]);
        const r = await runSourceDocumentWatch(bodies({ [OA.url]: 'a', [KWS.url]: 'b' }));

        expect(r).toMatchObject({ verdict: 'clean', watched: 2, firstSeen: 2, unchanged: 0, changed: 0 });
        expect(store.get(OA.url)).toMatchObject({
            citation: OA.key,
            publisher: 'МЗХ',
            series: 'operativen-analiz',
            sha256: sha('a'),
            bytes: 1,
            lastStatus: 'ok',
            changedAt: null,
        });
        // The non-МЗХ citation is stored with a null series, never a guess.
        expect(store.get(KWS.url)!.series).toBeNull();
        expect(r.unclassified).toEqual([KWS.key]);
    });

    it('a second run over identical bytes reports `unchanged`, not a change', async () => {
        cited.mockReturnValue([OA]);
        const served = bodies({ [OA.url]: 'a' });
        await runSourceDocumentWatch(served);
        const r = await runSourceDocumentWatch(served);

        expect(r).toMatchObject({ verdict: 'clean', unchanged: 1, changed: 0, firstSeen: 0 });
    });

    it('FLAGS a changed document and LEAVES the baseline hash alone', async () => {
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));
        updates.length = 0;

        const r = await runSourceDocumentWatch(bodies({ [OA.url]: 'revised' }));

        expect(r).toMatchObject({ verdict: 'changed', changed: 1, flaggedTotal: 1 });
        const row = store.get(OA.url)!;
        expect(row.sha256).toBe(sha('a')); // the baseline SURVIVES
        expect(row.changedSha256).toBe(sha('revised'));
        expect(row.changedBytes).toBe('revised'.length);
        expect(row.changedAt).toBeInstanceOf(Date);

        // The shape assertion: the flagging update must not carry `sha256` at
        // all. Asserting only the stored value would still pass if the code
        // wrote the SAME hash back, and would not survive a refactor that
        // started writing it.
        const flagging = updates.find((u) => 'changedSha256' in u.data)!;
        expect(flagging).toBeDefined();
        expect(Object.keys(flagging.data)).not.toContain('sha256');
        expect(Object.keys(flagging.data)).not.toContain('bytes');
    });

    it('a standing flag is NOT re-stamped by the next run over the same bytes', async () => {
        // Otherwise one revision reads as a fresh incident every day, and the
        // date a reviewer needs — when it FIRST changed — is lost.
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));
        await runSourceDocumentWatch(bodies({ [OA.url]: 'revised' }));
        const firstFlaggedAt = store.get(OA.url)!.changedAt!;

        const r = await runSourceDocumentWatch(bodies({ [OA.url]: 'revised' }));

        expect(r).toMatchObject({ verdict: 'clean', alreadyFlagged: 1, changed: 0, flaggedTotal: 1 });
        expect(store.get(OA.url)!.changedAt!.getTime()).toBe(firstFlaggedAt.getTime());
    });

    it('a SECOND distinct revision moves the flag forward', async () => {
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));
        await runSourceDocumentWatch(bodies({ [OA.url]: 'revised' }));
        const r = await runSourceDocumentWatch(bodies({ [OA.url]: 'revised again' }));

        expect(r).toMatchObject({ verdict: 'changed', changed: 1 });
        expect(store.get(OA.url)!.changedSha256).toBe(sha('revised again'));
        expect(store.get(OA.url)!.sha256).toBe(sha('a'));
    });

    it('a document reverted to its baseline CLEARS the flag', async () => {
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));
        await runSourceDocumentWatch(bodies({ [OA.url]: 'revised' }));
        expect(store.get(OA.url)!.changedAt).not.toBeNull();

        const r = await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));

        expect(r).toMatchObject({ verdict: 'clean', unchanged: 1, flaggedTotal: 0 });
        const row = store.get(OA.url)!;
        expect(row.changedAt).toBeNull();
        expect(row.changedSha256).toBeNull();
        expect(row.changedBytes).toBeNull();
    });

    it('`unreachable` when NOTHING could be read — never `clean`', async () => {
        // This is the verdict that exists so a total outage cannot read as
        // "every citation still holds".
        cited.mockReturnValue([OA, TK]);
        const r = await runSourceDocumentWatch(bodies({ [OA.url]: null, [TK.url]: null }));

        expect(r.verdict).toBe('unreachable');
        expect(r.changed).toBe(0);
        expect(r.failures).toHaveLength(2);
        expect(r.failures.map((f) => f.citation).sort()).toEqual([OA.key, TK.key].sort());
    });

    it('`partial` when some were read and some were not', async () => {
        cited.mockReturnValue([OA, TK]);
        const r = await runSourceDocumentWatch(bodies({ [OA.url]: 'a', [TK.url]: null }));

        expect(r).toMatchObject({ verdict: 'partial', firstSeen: 1 });
        expect(r.failures).toHaveLength(1);
    });

    it('a failure does NOT mint a row — a baseline must be bytes we read', async () => {
        // An invented baseline would make the next SUCCESSFUL run look like a
        // change, which is a false alarm manufactured by the watcher itself.
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: null }));

        expect(store.size).toBe(0);
        expect(updates).toHaveLength(0);
    });

    it('a failure on an EXISTING row records the attempt without touching the hash', async () => {
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));
        const r = await runSourceDocumentWatch(bodies({ [OA.url]: null }));

        expect(r.verdict).toBe('unreachable');
        const row = store.get(OA.url)!;
        expect(row.sha256).toBe(sha('a'));
        expect(row.lastStatus).toBe('unreachable');
        expect(row.lastCheckedAt).toBeInstanceOf(Date);
    });

    it('an EMPTY citation list is `no-citations`, not `clean`', async () => {
        // A count of zero over an empty population satisfies "nothing
        // changed" vacuously. The denominator is what separates them.
        cited.mockReturnValue([]);
        const r = await runSourceDocumentWatch(bodies({}));

        expect(r).toMatchObject({ verdict: 'no-citations', watched: 0, changed: 0 });
        expect(warn).toHaveBeenCalledWith(
            'source_document_watch.no_citations',
            expect.objectContaining({ watched: 0 }),
        );
    });

    it('the reading carries the DENOMINATOR beside every figure', async () => {
        cited.mockReturnValue([OA, TK]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a', [TK.url]: 'b' }));

        expect(info).toHaveBeenCalledWith(
            'source_document_watch.reading',
            expect.objectContaining({
                component: 'source-document-watch',
                verdict: 'clean',
                watched: 2,
                firstSeen: 2,
                flaggedTotal: 0,
            }),
        );
    });

    it('a change logs at WARN, so it is not buried in an info stream', async () => {
        cited.mockReturnValue([OA]);
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a' }));
        warn.mockReset();
        await runSourceDocumentWatch(bodies({ [OA.url]: 'revised' }));

        expect(warn).toHaveBeenCalledWith(
            'source_document_watch.reading',
            expect.objectContaining({ verdict: 'changed', changed: 1 }),
        );
        expect(info).not.toHaveBeenCalledWith(
            'source_document_watch.reading',
            expect.objectContaining({ verdict: 'changed' }),
        );
    });

    it('reads every baseline in ONE query, not one per document', async () => {
        // The D1 N+1 the query-shape guardrail refuses. Thirteen round trips
        // for one indexed lookup is the shape this asserts against.
        cited.mockReturnValue([OA, TK, KWS]);
        const findMany = jest.spyOn(
            (await import('@/lib/prisma')).prisma.sourceDocumentWatch,
            'findMany',
        );
        await runSourceDocumentWatch(bodies({ [OA.url]: 'a', [TK.url]: 'b', [KWS.url]: 'c' }));

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0]![0]).toMatchObject({
            where: { url: { in: [OA.url, TK.url, KWS.url] } },
        });
        findMany.mockRestore();
    });
});
