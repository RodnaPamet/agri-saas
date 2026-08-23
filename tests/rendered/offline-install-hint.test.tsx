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
import en from '../../messages/en.json';

const OFFLINE = en.offline as unknown as Record<string, string>;
const HINT = OFFLINE.storageUnprotectedInstallHint;
const REFUSAL = OFFLINE.storageUnprotected;

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
