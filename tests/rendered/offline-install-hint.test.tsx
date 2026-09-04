/** @jest-environment jsdom */
/**
 * The refusal line offers a remedy — but only where one is known to exist.
 *
 * ## Why this string is gated rather than always shown
 *
 * Measured on a physical iPhone (2026-08-23/24): mobile Safari REFUSES
 * `navigator.storage.persist()` while the installed Home Screen app GRANTS it.
 * So for an un-installed iOS operator the refusal is bad news *with a remedy*,
 * and the app already had that fact at enqueue time and said nothing.
 *
 * The gate is deliberately narrow. It is NOT "any browser that refused":
 *   - already installed → the advice is nonsense, and the grant means the
 *     refusal line should not be showing anyway;
 *   - Chromium → a refusal there reflects low engagement, and installing is not
 *     the documented remedy, so the same sentence would be a guess wearing the
 *     clothes of a measurement;
 *   - Chrome/Firefox ON iOS → excluded by `isIos`, because the Share-sheet
 *     instruction the copy implies would be wrong for them.
 *
 * All four combinations are exercised, because a gate that silently answers
 * `true` everywhere looks identical to a correct one in a single happy-path
 * test.
 */
import { render, screen, act } from '@testing-library/react';
import { OfflineSyncBar } from '@/components/offline/OfflineSyncBar';
import { UnsyncedWorkBanner } from '@/components/offline/UnsyncedWorkBanner';
import en from '../../messages/en.json';

const OFFLINE = en.offline as unknown as Record<string, string>;
const HINT = OFFLINE.storageUnprotectedInstallHint;
const REFUSAL = OFFLINE.storageUnprotected;
const PILL_HINT = OFFLINE.installToKeep;

/** Mutable so each pill case can set the snapshot it needs. */
const sync = {
    pending: 1,
    pendingPhotos: 0,
    lost: null as unknown,
    online: false,
    durability: { supported: true, persisted: false } as unknown,
    acknowledgeLostWork: () => {},
};
jest.mock('@/lib/offline/use-offline-sync', () => ({
    useOfflineSync: () => sync,
}));

const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID =
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36';
const IOS_CHROME = `${IPHONE} CriOS/125.0`;

function setEnv(opts: { ua: string; standalone: boolean }) {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: opts.ua });
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: opts.standalone });
    window.matchMedia = ((q: string) => ({
        matches: opts.standalone && q.includes('display-mode: standalone'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

async function renderBar(over: Partial<React.ComponentProps<typeof OfflineSyncBar>> = {}) {
    await act(async () => {
        render(
            <OfflineSyncBar
                online={false}
                pending={1}
                storagePersisted={false}
                onSyncNow={() => {}}
                {...over}
            />,
        );
    });
}

describe('the install remedy is offered exactly where it applies', () => {
    it('un-installed iOS Safari — refusal AND remedy', async () => {
        setEnv({ ua: IPHONE, standalone: false });
        await renderBar();
        expect(screen.getByTestId('offline-storage-unprotected')).toHaveTextContent(REFUSAL);
        expect(screen.getByTestId('offline-storage-unprotected')).toHaveTextContent(HINT);
    });

    it('installed iOS — no remedy, because there is nothing left to install', async () => {
        setEnv({ ua: IPHONE, standalone: true });
        await renderBar();
        expect(screen.queryByText(new RegExp(HINT.slice(0, 30)))).toBeNull();
    });

    it('Android Chromium — refusal without the remedy', async () => {
        // Installing is not the documented fix for a Chromium refusal, so the
        // sentence would be advice we have not measured.
        setEnv({ ua: ANDROID, standalone: false });
        await renderBar();
        expect(screen.getByTestId('offline-storage-unprotected')).toHaveTextContent(REFUSAL);
        expect(screen.queryByText(new RegExp(HINT.slice(0, 30)))).toBeNull();
    });

    it('Chrome on iOS — excluded, its Share-sheet story differs', async () => {
        setEnv({ ua: IOS_CHROME, standalone: false });
        await renderBar();
        expect(screen.queryByText(new RegExp(HINT.slice(0, 30)))).toBeNull();
    });

    it('says nothing at all when persistence was GRANTED', async () => {
        // The whole block is behind `storagePersisted === false`. A granted
        // phone must not be nagged to install.
        setEnv({ ua: IPHONE, standalone: false });
        await renderBar({ storagePersisted: true });
        expect(screen.queryByTestId('offline-storage-unprotected')).toBeNull();
    });

    it('says nothing when there is no pending work to lose', async () => {
        setEnv({ ua: IPHONE, standalone: false });
        await renderBar({ pending: 0 });
        expect(screen.queryByTestId('offline-storage-unprotected')).toBeNull();
    });
});


/**
 * #744 — the remedy has to travel with the WORK.
 *
 * `OfflineSyncBar` mounts on five surfaces; `UnsyncedWorkBanner` mounts once,
 * app-wide, in `ClientProviders`. An operator who queues a journal entry and
 * walks to the map keeps the work and loses the advice — and the lost-work
 * banner is too late by construction, because by the time it renders the thing
 * the install would have protected is gone.
 *
 * These cases pin the pill's gate, not the sync bar's. They matter because a
 * class-wide storage sweep leaves the loss DETECTOR nothing to read (see the
 * read-set test in tests/unit/offline/outbox-eviction.test.ts), so PREVENTING
 * the eviction is the only lever left on iOS.
 */
describe('the install remedy rides the app-wide pending pill (#744)', () => {
    beforeEach(() => {
        sync.pending = 1;
        sync.pendingPhotos = 0;
        sync.lost = null;
        sync.online = false;
        sync.durability = { supported: true, persisted: false };
    });

    async function renderPill() {
        await act(async () => {
            render(<UnsyncedWorkBanner />);
        });
    }

    it('un-installed iOS Safari with work pending — the pill carries the remedy', async () => {
        setEnv({ ua: IPHONE, standalone: false });
        await renderPill();
        expect(screen.getByTestId('offline-unsynced-pill')).toBeInTheDocument();
        expect(screen.getByTestId('offline-pill-install-hint')).toHaveTextContent(PILL_HINT);
    });

    it('installed iOS — the pill stays, the remedy goes', async () => {
        // The decisive contrast: same pending work, same refusal-capable
        // platform, and the hint disappears because there is nothing left to
        // install. Without this case the gate could be `true` and pass.
        setEnv({ ua: IPHONE, standalone: true });
        await renderPill();
        expect(screen.getByTestId('offline-unsynced-pill')).toBeInTheDocument();
        expect(screen.queryByTestId('offline-pill-install-hint')).toBeNull();
    });

    it('Android Chromium — no remedy, its Share-sheet story differs', async () => {
        setEnv({ ua: ANDROID, standalone: false });
        await renderPill();
        expect(screen.queryByTestId('offline-pill-install-hint')).toBeNull();
    });

    it('says nothing when persistence was GRANTED', async () => {
        setEnv({ ua: IPHONE, standalone: false });
        sync.durability = { supported: true, persisted: true };
        await renderPill();
        expect(screen.queryByTestId('offline-pill-install-hint')).toBeNull();
    });

    it('says nothing when the verdict has never been measured', async () => {
        // `null` is not `false`. Advising an install on an unmeasured device
        // would be advice we have no evidence for.
        setEnv({ ua: IPHONE, standalone: false });
        sync.durability = null;
        await renderPill();
        expect(screen.queryByTestId('offline-pill-install-hint')).toBeNull();
    });

    it('says nothing when there is no work to lose — no pill, no advice', async () => {
        setEnv({ ua: IPHONE, standalone: false });
        sync.pending = 0;
        await renderPill();
        expect(screen.queryByTestId('offline-unsynced-pill')).toBeNull();
        expect(screen.queryByTestId('offline-pill-install-hint')).toBeNull();
    });
});
