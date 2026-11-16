/**
 * `GET /api/agro-calendar` — the route's own decisions.
 *
 * The dataset and the query are covered next door; this is about what the
 * route REFUSES and what shape it hands back, both of which are contract with
 * the phone.
 */
const getUserCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getUserCtx: (...a: unknown[]) => getUserCtxMock(...a),
}));

const assertFeatureEnabledMock = jest.fn();
jest.mock('@/lib/feature-flags', () => ({
    ...(jest.requireActual('@/lib/feature-flags') as object),
    assertFeatureEnabled: (...a: unknown[]) => assertFeatureEnabledMock(...a),
}));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/agro-calendar/route';

/**
 * The wrapped handler's type takes a second argument even for a route with no
 * dynamic segments — `withApiErrorHandling` exports the Next-shaped signature.
 * ts-jest transpiles per file and does not typecheck, so this passed under
 * jest and only `tsc` objected.
 */
const NO_PARAMS = { params: Promise.resolve({}) };

function call(qs: string) {
    return GET(new NextRequest(`https://app.agrent.bg/api/agro-calendar${qs}`), NO_PARAMS);
}

beforeEach(() => {
    jest.clearAllMocks();
    getUserCtxMock.mockResolvedValue({ userId: 'u-1' });
    assertFeatureEnabledMock.mockResolvedValue(undefined);
});

describe('what it refuses', () => {
    it('refuses a missing or unrecognised region, rather than defaulting', () => {
        /*
         * A default would serve one half of the country's sowing dates to the
         * other half, silently. North and South Bulgaria differ by up to three
         * weeks on some windows, and a sowing date is not a thing to guess at.
         */
        return Promise.all(
            ['', '?region=', '?region=middle', '?region=NORTH'].map(async (qs) => {
                const res = await call(qs);
                expect(res.status).toBe(400);
            }),
        );
    });

    it('refuses an unknown group', async () => {
        expect((await call('?region=north&group=trees')).status).toBe(400);
    });

    it('refuses an unknown crop key, rather than answering with an empty list', async () => {
        // An empty list reads as "we cover this crop and have nothing to say",
        // which is a different claim from "we do not cover it".
        expect((await call('?region=north&crop=bananas')).status).toBe(400);
    });

    it('is gated — the flag is checked BEFORE the region is parsed', async () => {
        /*
         * `withApiErrorHandling` converts a throw into a response, so this
         * asserts the status rather than a rejection — the wrapper is the
         * contract, not an implementation detail to route around.
         *
         * The ORDER is the property worth pinning: the gate runs before the
         * query is validated, so an unlaunched surface answers the same way
         * for a good request as for a malformed one and does not announce
         * itself through its error messages.
         */
        assertFeatureEnabledMock.mockRejectedValue(new Error('flag off'));
        const res = await call('?region=north');
        expect(res.status).not.toBe(200);
        expect(assertFeatureEnabledMock).toHaveBeenCalledWith('agro.calendar', 'u-1');

        // Even with a BAD region, the gate is what refused — the 400 never
        // gets a chance to leak that the route exists.
        assertFeatureEnabledMock.mockClear();
        assertFeatureEnabledMock.mockRejectedValue(new Error('flag off'));
        const bad = await call('?region=middle');
        expect(bad.status).not.toBe(200);
        expect(assertFeatureEnabledMock).toHaveBeenCalledTimes(1);
    });
});

describe('what it answers', () => {
    it('serves the region with its sources, conventions and an ETag', async () => {
        const res = await call('?region=north');
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toBeTruthy();

        const body = await res.json();
        expect(body.region).toBe('north');
        expect(body.schemaVersion).toBe(1);
        expect(body.compiledAt).toBeTruthy();
        expect(Array.isArray(body.conventions)).toBe(true);
        expect(body.conventions.length).toBeGreaterThan(0);
        expect(body.crops.length).toBeGreaterThan(0);
        // `sources` is GONE — owner instruction 2026-11-16. A bibliography
        // with nothing citing it is a list of books on a farming screen.
        expect(body.sources).toBeUndefined();
    });

    it('serves NO citation anywhere in the payload', async () => {
        /*
         * Owner instruction 2026-11-16: the «МЗХ, 2024, стр. 190» line comes
         * off the screen. The phone renders what it is sent, so this asserts
         * the ABSENCE on the response — the only place that settles it for
         * every client at once.
         *
         * This test previously asserted the opposite ("every served window
         * carries a resolvable citation"). The guarantee it protected has NOT
         * been dropped, it has moved: `load.test.ts` holds "every window is
         * cited, and every citation resolves" against the DATASET, and the
         * loader still refuses one that breaks it. What changed is whether
         * the citation is displayed, not whether it must exist.
         *
         * Asserted by WALKING the payload rather than by naming the two keys
         * I happen to know about: `cites` on a window and `cite` on the costs
         * block are the two today, and a third added later would be served
         * silently by a check that only knows these.
         */
        const body = await (await call('?region=south')).json();
        const windows = body.crops.flatMap((c: { windows: unknown[] }) => c.windows);
        // Control: the payload is not empty, so the absences below mean
        // something. Without it a broken filter passes every assertion here.
        expect(windows.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        (function walk(node: unknown, path: string): void {
            if (Array.isArray(node)) {
                node.forEach((v, i) => walk(v, `${path}[${i}]`));
                return;
            }
            if (node && typeof node === 'object') {
                for (const [k, v] of Object.entries(node)) {
                    if (k === 'cite' || k === 'cites') offenders.push(`${path}.${k}`);
                    walk(v, `${path}.${k}`);
                }
            }
        })(body, '$');
        expect(offenders).toEqual([]);
    });

    it('CONTROL — the walker finds a citation when one is there', () => {
        // The negation above passes over an empty crawl. This proves the
        // walker can see the very shape it is asserting the absence of.
        const seeded = { crops: [{ windows: [{ cites: [{ source: 's1', page: 20 }] }] }] };
        const found: string[] = [];
        (function walk(node: unknown, path: string): void {
            if (Array.isArray(node)) {
                node.forEach((v, i) => walk(v, `${path}[${i}]`));
                return;
            }
            if (node && typeof node === 'object') {
                for (const [k, v] of Object.entries(node)) {
                    if (k === 'cite' || k === 'cites') found.push(`${path}.${k}`);
                    walk(v, `${path}.${k}`);
                }
            }
        })(seeded, '$');
        expect(found).toEqual(['$.crops[0].windows[0].cites']);
    });

    it('filters by group, and a 304 is available on a repeat', async () => {
        const body = await (await call('?region=north&group=perennial')).json();
        expect(body.crops.length).toBeGreaterThan(0);
        expect(body.crops.every((c: { group: string }) => c.group === 'perennial')).toBe(true);

        const first = await call('?region=north&group=perennial');
        const etag = first.headers.get('etag') as string;
        const again = GET(
            new NextRequest('https://app.agrent.bg/api/agro-calendar?region=north&group=perennial', {
                headers: { 'if-none-match': etag },
            }),
            NO_PARAMS,
        );
        expect((await again).status).toBe(304);
    });

    it('north and south differ, which is why the parameter is required', async () => {
        // If they were identical the parameter would be ceremony. They are
        // not: some windows are region-specific by three weeks.
        const north = await (await call('?region=north')).json();
        const south = await (await call('?region=south')).json();
        const ids = (b: { crops: { windows: { id: string }[] }[] }) =>
            new Set(b.crops.flatMap((c) => c.windows.map((w) => w.id)));
        const n = ids(north);
        const s = ids(south);
        const onlyNorth = [...n].filter((i) => !s.has(i));
        const onlySouth = [...s].filter((i) => !n.has(i));
        expect(onlyNorth.length).toBeGreaterThan(0);
        expect(onlySouth.length).toBeGreaterThan(0);
    });
});
