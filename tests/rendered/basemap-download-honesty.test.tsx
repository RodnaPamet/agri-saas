/**
 * The offline-map download button must not report success over an empty pack.
 *
 * ## The defect (#780)
 *
 * The tile proxy soft-fails to **204** when the upstream is unreachable, and
 * it also returns 204 when the upstream legitimately has no tile (ocean, out
 * of coverage). The button counted both:
 *
 *     // 200 = a real tile cached; 204 = ocean/no-coverage (fine).
 *     if (res.ok || res.status === 204) ok += 1;
 *
 * So a CDN outage produced a clean sweep of 204s, `ok === tiles.length`, and
 * a confident **"Offline map ready"** over a pack containing nothing. The
 * operator then drove out of signal and found an empty map — the failure
 * discovered at the exact moment the feature exists to prevent.
 *
 * This is the same family as the outbox work: `pending` that will never send
 * (#763), "synced" over an evicted queue (#744), "downloaded" over zero tiles.
 * A UI that reassures without evidence.
 *
 * ## Why plain-object stubs and not `new Response(...)`
 *
 * **The jsdom project ships no `Response` and no `fetch`.** `new Response(...)`
 * throws a ReferenceError inside the mock, the component's `catch {}` swallows
 * it, and the run looks like a total failure — which on UNFIXED code produces
 * the same `toast.error` the fixed code produces, so the regression tests
 * would pass against the bug. That is the trap this file is written to avoid;
 * `tests/rendered/bins-client-kind-filter.test.tsx` documents the same
 * limitation.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const toastSuccess = jest.fn();
const toastError = jest.fn();
const toastWarning = jest.fn();
jest.mock('@/components/ui/hooks/use-toast', () => ({
    __esModule: true,
    useToast: () => ({
        success: toastSuccess,
        error: toastError,
        info: jest.fn(),
        warning: toastWarning,
    }),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    __esModule: true,
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
}));

import { DownloadBasemapButton } from '@/components/ui/map/DownloadBasemapButton';

/**
 * A minimal fetch Response — see the docblock for why this is not `new Response`.
 *
 * `bytes` is the BODY length now, not a `Content-Length` header (#3147). The
 * sweep measures `res.clone().arrayBuffer()`, because Next 16.4.5 strips
 * `content-length` from every route-handler response and the old header read
 * then counted every tile as lost.
 *
 * `contentLength` is kept as a SEPARATE knob so a test can set the two
 * independently — which is the whole point: a tile with real bytes and NO
 * header is the regression case, and a double that derived one from the other
 * could not express it.
 */
function tile(
    status: number,
    opts: { bytes?: number; source?: string; contentLength?: number } = {},
) {
    const headers = new Map<string, string>();
    if (opts.contentLength !== undefined) {
        headers.set('content-length', String(opts.contentLength));
    }
    if (opts.source) headers.set('x-basemap-source', opts.source);
    const body = new ArrayBuffer(opts.bytes ?? 0);
    /*
     * The double MODELS BODY CONSUMPTION, and that is not decoration: a
     * mutation replacing `res.clone().arrayBuffer()` with
     * `res.arrayBuffer()` survived the first version of this suite, because a
     * `clone()` returning `this` makes the two indistinguishable.
     *
     * The property is real — the service worker caches `res.clone()` on the
     * way past, so consuming the ORIGINAL here races it — and a double that
     * cannot express it leaves the one line protecting it untested.
     */
    const res = {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
        bodyUsed: false,
        async arrayBuffer() {
            this.bodyUsed = true;
            return body;
        },
        /** A SEPARATE object with its own body, like the real `clone()`. */
        clone() {
            return {
                status,
                ok: status >= 200 && status < 300,
                headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
                bodyUsed: false,
                async arrayBuffer() {
                    this.bodyUsed = true;
                    return body;
                },
            };
        },
    };
    served.push(res);
    return res as unknown as Response;
}

/** Every response the sweep was handed this test, for the consumption check. */
let served: Array<{ bodyUsed: boolean }> = [];

const BOUNDS: [number, number, number, number] = [23.3, 42.6, 23.4, 42.8];

function mockAll(res: () => Response) {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => res());
}

beforeEach(() => {
    jest.clearAllMocks();
    served = [];
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} });
});

afterEach(() => {
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
});

async function clickDownload() {
    render(<DownloadBasemapButton locationId="loc-1" bounds={BOUNDS} />);
    const btn = await screen.findByRole('button');
    btn.click();
}

describe('#780 — the toast must describe the pack that actually exists', () => {
    it('an all-204 sweep from an UNREACHABLE upstream is an error, not "ready"', async () => {
        // The reported bug, exactly: the CDN is down, every tile soft-fails to
        // 204, and the old code counted every one of them as cached.
        mockAll(() => tile(204, { source: 'upstream-unreachable' }));

        await clickDownload();

        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('a 200 with ZERO bytes is not a tile', async () => {
        // A 200 carrying nothing satisfies `res.ok` while caching an empty
        // body — the "0-byte 200" shape the basemap fixture docblock warns
        // about, arriving from the network instead of a fixture.
        mockAll(() => tile(200, { bytes: 0 }));

        await clickDownload();

        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('an all-204 sweep from a legitimately EMPTY upstream IS a complete pack', async () => {
        // The positive control, and the reason the fix reads the provenance
        // header rather than just rejecting 204. Ocean tiles are a correct
        // answer; a pack that skips them is finished, not broken. Without
        // this, "reject every 204" would pass the two tests above while
        // reporting failure over a perfectly good pack.
        mockAll(() => tile(204, { source: 'upstream-empty' }));

        await clickDownload();

        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        expect(toastError).not.toHaveBeenCalled();
        expect(toastWarning).not.toHaveBeenCalled();
    });

    it('a tile with BYTES but no Content-Length is stored — #3147', async () => {
        /*
         * The regression that shipped as an E2E failure nobody could explain.
         *
         * Next 16.4.5 added a FORBIDDEN_HEADERS set stripping `content-length`
         * from every route-handler response (vercel/next.js#101120). The sweep
         * read that header, measured zero, counted every tile LOST, and never
         * fired the toast — a pack that downloaded perfectly reporting total
         * failure, with no error anywhere.
         *
         * So: real bytes, header absent. Before the fix this was `error`.
         */
        mockAll(() => tile(200, { bytes: 38, source: 'upstream' }));
        await clickDownload();
        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        expect(toastError).not.toHaveBeenCalled();
        expect(toastWarning).not.toHaveBeenCalled();
    });

    it('CONTROL — a Content-Length header alone does not make a tile', async () => {
        // The other direction, and the reason the double carries the two
        // independently: a response claiming 38 bytes while carrying none is
        // still an empty tile. A fix that merely switched which header it
        // trusted would pass the case above and fail this one.
        mockAll(() => tile(200, { bytes: 0, contentLength: 38 }));
        await clickDownload();
        await waitFor(() => expect(toastError).toHaveBeenCalled());
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('never consumes the ORIGINAL response — the service worker needs it', async () => {
        /*
         * The sweep reads a CLONE. Consuming the original would race the
         * service worker, which caches `res.clone()` on the way past — so a
         * tile would be counted and then not cached, which is the failure the
         * whole download exists to avoid.
         *
         * Asserted because a mutation proved it was not: swapping
         * `res.clone().arrayBuffer()` for `res.arrayBuffer()` passed every
         * other case in this file. A `clone()` that returns `this` cannot
         * tell them apart, so the double models consumption instead.
         */
        mockAll(() => tile(200, { bytes: 38, source: 'upstream' }));
        await clickDownload();
        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

        expect(served.length).toBeGreaterThan(0); // control: it served some
        expect(served.every((r) => r.bodyUsed === false)).toBe(true);
    });

    it('real tiles report ready', async () => {
        mockAll(() => tile(200, { bytes: 38, source: 'upstream' }));

        await clickDownload();

        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        expect(toastError).not.toHaveBeenCalled();
    });

    it('a PARTIAL pack warns, and does not label itself ready', async () => {
        // Claiming "Offline map ready" over an admittedly incomplete pack is a
        // milder instance of the same over-claim, so the button stays on its
        // download affordance and the operator can retry.
        let n = 0;
        (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () =>
            n++ === 0 ? tile(200, { bytes: 38 }) : tile(204, { source: 'upstream-unreachable' }),
        );

        await clickDownload();

        await waitFor(() => expect(toastWarning).toHaveBeenCalled());
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(screen.getByRole('button').textContent).not.toContain('ready');
    });
});
