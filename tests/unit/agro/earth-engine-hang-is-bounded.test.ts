/**
 * A hung Earth Engine must FAIL, not hang. (satellite buttons, #1302)
 *
 * ## The defect this pins
 *
 * Every EE round-trip is a callback API wrapped in a promise. Wrapped with no
 * deadline, a callback that is never invoked leaves the promise pending for
 * ever — and **a hang is not a throw**, so neither the `try/catch` inside
 * `earth-engine.ts` nor the soft `generation_failed` arm in
 * `index-tiles-handler.ts` can see it. The request never completes: the
 * browser gives up and reports that the server did not respond, and all five
 * index buttons fail together because they share one handshake.
 *
 * The init case was the worst of the five, and is the first test below.
 * `initPromise` is memoised at module scope with a `.catch` that clears the
 * memo so a transient failure retries. That is true of REJECTIONS. A hang
 * leaves it pending, the `.catch` never runs, and every later request in that
 * container awaits a promise that will never settle — sticky until the
 * container is replaced, which is why the symptom returns rather than
 * flickering.
 *
 * ## Why no existing test could catch it
 *
 * The five route suites (`ndvi-tiles-route.test.ts` and siblings) all
 * `jest.mock('@/lib/agro/earth-engine')` wholesale, so they never execute the
 * module that holds the defect. `earth-engine-index.test.ts` does drive the
 * real module, but its mock calls every callback SYNCHRONOUSLY — the one input
 * shape under which an unbounded wrapper behaves perfectly.
 *
 * So this file mocks the PACKAGE with callbacks that never fire. That is the
 * input the old code could not survive and the new code must.
 */
const neverCalled = jest.fn();

jest.mock('@/env', () => ({
    env: {
        GEE_PROJECT_ID: 'proj',
        GEE_SERVICE_ACCOUNT_KEY: JSON.stringify({ type: 'service_account' }),
    },
}));

/** Which EE step should go silent. Read lazily inside the mock closures. */
const hang: { auth: boolean; getMap: boolean } = { auth: false, getMap: false };
const authAttempts = jest.fn();

jest.mock('@google/earthengine', () => {
    const img: Record<string, (...a: unknown[]) => unknown> = {};
    const ret = () => img;
    for (const k of [
        'select', 'neq', 'and', 'updateMask', 'divide', 'rename', 'clip', 'get',
        'normalizedDifference', 'expression',
    ]) img[k] = ret;
    img.getMap = (_vis: unknown, cb: unknown) => {
        if (hang.getMap) return; // the callback never arrives
        (cb as (m: { urlFormat: string }) => void)({ urlFormat: 'https://ee/tiles/{z}/{x}/{y}' });
    };
    const collection: Record<string, (...a: unknown[]) => unknown> = {};
    for (const k of ['filterBounds', 'filterDate', 'filter', 'sort']) collection[k] = () => collection;
    collection.first = () => img;
    collection.size = () => ({ gt: () => ({}) });
    collection.map = () => collection;
    collection.median = () => img;
    collection.aggregate_max = () => ({
        // The date label is best-effort and must never be what hangs a tile:
        // it resolves immediately here so a failure below is unambiguously the
        // step under test.
        evaluate: (cb: (v: unknown, err?: unknown) => void) => cb(1_700_000_000_000),
    });
    return {
        __esModule: true,
        default: {
            data: {
                authenticateViaPrivateKey: (_k: unknown, ok: () => void) => {
                    authAttempts();
                    if (hang.auth) return; // neither callback ever arrives
                    ok();
                },
            },
            initialize: (_a: unknown, _b: unknown, ok: () => void) => ok(),
            Geometry: { Rectangle: () => ({}) },
            Filter: { lt: () => ({}) },
            ImageCollection: () => collection,
            Date: () => ({ advance: () => ({}) }),
            Algorithms: { If: (_c: unknown, t: unknown) => t },
        },
    };
});

const AOI = { west: 25, south: 42, east: 25.1, north: 42.1 };
const WIN = { start: '2026-09-01', end: '2026-10-01' };

describe('a hung Earth Engine fails instead of hanging', () => {
    beforeEach(() => {
        jest.resetModules();
        hang.auth = false;
        hang.getMap = false;
        authAttempts.mockClear();
        jest.useFakeTimers();
    });
    afterEach(() => jest.useRealTimers());

    it('control: with callbacks that DO fire, a tile URL comes back', async () => {
        // Without this the rejections below could be the mock being wrong
        // rather than the deadline working.
        const { getNdviTileUrl } = require('@/lib/agro/earth-engine');
        await expect(getNdviTileUrl(AOI, WIN)).resolves.toMatchObject({
            tileUrl: expect.stringContaining('https://ee/tiles'),
        });
        expect(neverCalled).not.toHaveBeenCalled();
    });

    it('a silent AUTH rejects on the deadline rather than pending for ever', async () => {
        hang.auth = true;
        const { getNdviTileUrl } = require('@/lib/agro/earth-engine');

        const settled = expect(getNdviTileUrl(AOI, WIN)).rejects.toThrow(
            /did not respond within/i,
        );
        // 10s init budget. Advancing asynchronously flushes the microtasks the
        // rejection travels through; `advanceTimersByTime` alone would not.
        await jest.advanceTimersByTimeAsync(11_000);
        await settled;
    });

    it('THE STICKY HALF: a silent auth does not poison the memo for every later request', async () => {
        // This is the assertion the production symptom demanded. `initPromise`
        // is memoised; a HANG used to leave it pending so every subsequent
        // request in the container awaited a promise that would never settle,
        // and the buttons stayed broken until the container was replaced. The
        // deadline rejects, the existing `.catch` clears the memo, and the next
        // request gets a FRESH handshake — observable as a second auth attempt.
        hang.auth = true;
        const { getNdviTileUrl } = require('@/lib/agro/earth-engine');

        const first = expect(getNdviTileUrl(AOI, WIN)).rejects.toThrow(/did not respond/i);
        await jest.advanceTimersByTimeAsync(11_000);
        await first;
        expect(authAttempts).toHaveBeenCalledTimes(1);

        const second = expect(getNdviTileUrl(AOI, WIN)).rejects.toThrow(/did not respond/i);
        await jest.advanceTimersByTimeAsync(11_000);
        await second;
        // TWO attempts, not one: the memo was cleared and the retry really ran.
        expect(authAttempts).toHaveBeenCalledTimes(2);
    });

    it('a silent getMap rejects on the deadline too', async () => {
        hang.getMap = true;
        const { getNdviTileUrl } = require('@/lib/agro/earth-engine');

        const settled = expect(getNdviTileUrl(AOI, WIN)).rejects.toThrow(
            /did not respond within/i,
        );
        await jest.advanceTimersByTimeAsync(26_000);
        await settled;
    });

    it('every index shares the bound, not just NDVI', async () => {
        // The buttons fail together because they share one handshake, so the
        // fix has to hold for all five or the next report is "EVI is broken".
        hang.auth = true;
        const ee = require('@/lib/agro/earth-engine');
        for (const fn of ['getNdviTileUrl', 'getNdmiTileUrl', 'getNdreTileUrl', 'getGndviTileUrl', 'getEviTileUrl']) {
            const settled = expect(ee[fn](AOI, WIN)).rejects.toThrow(/did not respond within/i);
            await jest.advanceTimersByTimeAsync(11_000);
            await settled;
        }
    });
});
