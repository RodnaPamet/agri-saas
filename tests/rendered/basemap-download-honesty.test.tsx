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

/** A minimal fetch Response — see the docblock for why this is not `new Response`. */
function tile(status: number, opts: { bytes?: number; source?: string } = {}) {
    const headers = new Map<string, string>();
    if (opts.bytes !== undefined) headers.set('content-length', String(opts.bytes));
    if (opts.source) headers.set('x-basemap-source', opts.source);
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    } as unknown as Response;
}

const BOUNDS: [number, number, number, number] = [23.3, 42.6, 23.4, 42.8];

function mockAll(res: () => Response) {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => res());
}

beforeEach(() => {
    jest.clearAllMocks();
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
