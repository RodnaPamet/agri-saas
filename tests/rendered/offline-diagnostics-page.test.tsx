/**
 * The offline diagnostics page shows the durability verdict in EVERY state.
 *
 * WHY THIS FILE EXISTS, stated plainly so it is not "simplified" later:
 *
 * The page is the instrument for issue #648, and its central design constraint
 * came from a real device session (#650 / #745): the EXISTING durability signal
 * is NEGATIVE-ONLY. `OfflineSyncBar` renders only when
 * `pending > 0 && storagePersisted === false`, and `offline-storage-verdict`
 * lives inside the LOST-WORK banner — i.e. it requires work to have already
 * been destroyed to be readable at all.
 *
 * So on screen today, three very different situations look identical:
 *
 *   • persistence GRANTED            (nothing renders)
 *   • persistence never MEASURED     (nothing renders)
 *   • nothing queued yet             (nothing renders)
 *
 * An instrument that inherits that property is useless: an operator on a phone
 * cannot tell "safe" from "unmeasured". These tests pin the opposite — that
 * each state is distinguishable, INCLUDING the absent one, which is the state
 * the old surface could not express.
 *
 * The cache assertions are the same idea for probe 2: #648 asks for each cache
 * BY NAME, so a MISSING one must be visible as missing rather than merely
 * absent from a list.
 *
 * VIEWPORT: not overridden. The page is a single column at every width and the
 * assertions are on text, not layout, so the jsdom phone default is honest here.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DURABILITY_STORAGE_KEY } from '@/lib/offline/durability';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/diagnostics/offline',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));

const snapshot = {
    pending: 0,
    pendingPhotos: 0,
    conflicts: [] as unknown[],
    lost: null,
    durability: null,
    queueGrowing: false,
    foreign: 0,
    blocked: 0,
    blockedAuth: 0,
};
jest.mock('@/lib/offline/outbox-state', () => ({
    getOutboxSnapshot: () => snapshot,
    refreshOutboxState: jest.fn().mockResolvedValue(undefined),
}));

import OfflineDiagnosticsPage from '@/app/t/[tenantSlug]/(app)/diagnostics/offline/page';

/** Minimal in-memory CacheStorage — jsdom defines none. */
class FakeCaches {
    constructor(private names: string[]) {}
    async keys() {
        return [...this.names];
    }
    async open(_name: string) {
        return { keys: async () => [{}, {}, {}] };
    }
}

function installCaches(names: string[]) {
    (globalThis as unknown as { caches: unknown }).caches = new FakeCaches(names);
}

const ALL_FOUR = ['agrent-v1-static', 'agrent-v1-pages', 'agrent-v1-fielddata', 'agrent-v1-basemap'];

beforeEach(() => {
    window.localStorage.clear();
    installCaches(ALL_FOUR);
    Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ quota: 1024 * 1024 * 500, usage: 1024 * 1024 * 12 }) },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
            controller: {},
            getRegistration: async () => ({ scope: 'https://x/', active: { state: 'activated' }, waiting: null }),
        },
    });
});

afterEach(() => {
    delete (globalThis as unknown as { caches?: unknown }).caches;
});

function writeVerdict(persisted: boolean) {
    window.localStorage.setItem(
        DURABILITY_STORAGE_KEY,
        JSON.stringify({
            supported: true,
            persisted,
            requested: true,
            quota: 1024 * 1024 * 500,
            usage: 1024 * 1024 * 12,
            at: '2026-08-24T00:00:00.000Z',
        }),
    );
}

describe('offline diagnostics — the verdict is legible in every state', () => {
    it('says NONE STORED when nothing has been measured — the state the old surface could not express', async () => {
        render(<OfflineDiagnosticsPage />);

        await waitFor(() => expect(screen.getByText('NONE STORED')).toBeInTheDocument());
        // And it says WHY, so the operator knows the next action rather than
        // reading absence as safety.
        expect(screen.getByText(/nothing has been queued on this device yet/i)).toBeInTheDocument();
    });

    it('shows persisted=false explicitly when persistence was REFUSED (mobile Safari)', async () => {
        writeVerdict(false);
        render(<OfflineDiagnosticsPage />);

        await waitFor(() => expect(screen.getByText('persisted')).toBeInTheDocument());
        const row = screen.getByText('persisted').closest('div')?.parentElement;
        expect(row).toHaveTextContent('false');
    });

    it('shows persisted=true explicitly when persistence was GRANTED (installed PWA)', async () => {
        // The state that renders NOTHING today — granted produces no banner, so
        // it is indistinguishable from unmeasured on the existing surface.
        writeVerdict(true);
        render(<OfflineDiagnosticsPage />);

        await waitFor(() => expect(screen.getByText('persisted')).toBeInTheDocument());
        const row = screen.getByText('persisted').closest('div')?.parentElement;
        expect(row).toHaveTextContent('true');
    });

    it('states that it READS the verdict rather than re-measuring it', async () => {
        // requestPersistence() is armed once per PAGE LOAD, so a page that
        // measured here would report a second, different answer than the one the
        // app stored. The operator has to be told which they are looking at.
        writeVerdict(true);
        render(<OfflineDiagnosticsPage />);

        await waitFor(() => expect(screen.getByText(/does not call/i)).toBeInTheDocument());
    });
});

describe('offline diagnostics — probe 2 asks for caches BY NAME', () => {
    it('lists all four caches with their entry counts', async () => {
        render(<OfflineDiagnosticsPage />);

        for (const key of ['STATIC_CACHE', 'PAGE_CACHE', 'DATA_CACHE', 'BASEMAP_CACHE']) {
            await waitFor(() => expect(screen.getByText(key)).toBeInTheDocument());
        }
        expect(screen.getAllByText('3 entries')).toHaveLength(4);
    });

    it('marks a cache MISSING rather than silently omitting it', async () => {
        // PAGE_CACHE is what serves the offline cold launch (probe 3). Its
        // absence is the finding; a list that just does not mention it reads as
        // "fine".
        installCaches(ALL_FOUR.filter((n) => !n.endsWith('-pages')));
        render(<OfflineDiagnosticsPage />);

        await waitFor(() => expect(screen.getByText('MISSING')).toBeInTheDocument());
        expect(screen.getByText('PAGE_CACHE')).toBeInTheDocument();
    });

    it('survives a context with no Cache Storage at all', async () => {
        delete (globalThis as unknown as { caches?: unknown }).caches;
        render(<OfflineDiagnosticsPage />);

        await waitFor(() => expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument());
    });
});

describe('offline diagnostics — the PASTED record, not just the screen', () => {
    /**
     * The page tells the operator to "press Copy and paste the text into the
     * issue" (`diagnostics.offline.intro`), so for #648 the paste IS the
     * artefact — a phone read at night, one-handed, is read from the paste.
     *
     * #763 added `blocked` / `blockedAuth` to the RENDERED rows and not to
     * `asText`. That is the worst possible half: post-#761 nothing leaves the
     * queue on a refused session or exhausted retries, it is retained and
     * marked, so `pending` alone no longer separates "waiting for signal" from
     * "will never move until you act". The record reaching the issue was
     * missing exactly the number that distinguishes them.
     *
     * These assertions execute `asText`, which nothing did before.
     */
    const original = { ...snapshot };

    afterEach(() => {
        Object.assign(snapshot, original);
    });

    function captureClipboard() {
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText },
        });
        return writeText;
    }

    async function copiedText(): Promise<string> {
        const writeText = captureClipboard();
        render(<OfflineDiagnosticsPage />);

        const button = await screen.findByRole('button', { name: 'Copy as text' });

        // The button renders on the FIRST paint, while `outbox` is still null
        // — clicking straight away copies `## outbox / unavailable` and the
        // assertion below fails for a reason that has nothing to do with the
        // fields under test. Observed intermittently before this wait: one of
        // the two tests would capture the settled snapshot and the other the
        // empty one, in the same run.
        //
        // `queueGrowing` renders ONLY inside the `outbox ? … : …` truthy
        // branch, so its presence is proof the snapshot has landed.
        await screen.findByText('queueGrowing');

        fireEvent.click(button);

        await waitFor(() => expect(writeText).toHaveBeenCalled());
        return writeText.mock.calls[0][0] as string;
    }

    it('carries blocked and blockedAuth, so "3 pending" cannot be misread as "3 will send"', async () => {
        Object.assign(snapshot, { pending: 3, pendingPhotos: 1, blocked: 2, blockedAuth: 1 });

        const text = await copiedText();

        expect(text).toContain('blocked=2');
        expect(text).toContain('blockedAuth=1');
    });

    it('mirrors every outbox field the page renders — the omission was one field going missing', async () => {
        Object.assign(snapshot, { pending: 3, pendingPhotos: 1, blocked: 2, blockedAuth: 1 });

        const text = await copiedText();
        const outboxLine = text.split('\n').find((l) => l.startsWith('pending='));

        expect(outboxLine).toBeDefined();
        // Same set, same order as the rendered rows in the `probes 4 · 6`
        // section. A future row added to one and not the other fails here.
        for (const field of [
            'pending',
            'photos',
            'blocked',
            'blockedAuth',
            'foreign',
            'conflicts',
            'queueGrowing',
        ]) {
            expect(outboxLine).toContain(`${field}=`);
        }
    });
});
