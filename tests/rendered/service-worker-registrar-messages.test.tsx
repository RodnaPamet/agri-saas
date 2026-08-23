/** @jest-environment jsdom */
/**
 * ServiceWorkerRegistrar — the messages the worker sends back (#740, #730).
 *
 * `public/sw.js` talks to its clients, and for a long time nobody was
 * listening. Both messages it sends are load-bearing and both failed silently:
 *
 *   - `outbox-db-recreated` — the worker won the race to reopen an evicted
 *     database and consumed the one `upgradeneeded` event the loss detector
 *     depends on (#730/#733). Only the page can tell the operator.
 *   - `outbox-flushed` — the worker drained the queue, and sw.js has carried
 *     the comment "Notify any open clients so their pending-count refreshes"
 *     since it was written, while no listener existed (#740). The count went
 *     on reporting work as saved-on-this-phone after it reached the server.
 *
 * This EXECUTES the handler rather than asserting on its source, because the
 * failure mode is a dispatch that quietly matches nothing — exactly what a
 * `toContain` on the file would miss. The registrar's effect early-returns
 * unless `NODE_ENV === 'production'`, so the suite forces it, mirroring
 * `service-worker-registrar-update.test.tsx`.
 */
import { render, act } from '@testing-library/react';

jest.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
jest.mock('@/components/pwa/InstallPrompt', () => ({ InstallPrompt: () => null }));

const drained = jest.fn();
const recreated = jest.fn();
jest.mock('@/lib/offline/outbox-state', () => ({
    noteOutboxDrainedElsewhere: (...a: unknown[]) => drained(...a),
    noteOutboxRecreatedElsewhere: (...a: unknown[]) => recreated(...a),
}));

import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';

let emit: (data: unknown) => void;

function installSwMock() {
    const listeners: Record<string, Array<(e: unknown) => void>> = {};
    const reg = { waiting: null, installing: null, addEventListener: jest.fn(), active: { postMessage: jest.fn() } };
    const serviceWorker = {
        controller: {},
        register: jest.fn(() => Promise.resolve(reg)),
        getRegistration: jest.fn(() => Promise.resolve(reg)),
        ready: Promise.resolve(reg),
        addEventListener: jest.fn((type: string, cb: (e: unknown) => void) => {
            (listeners[type] ||= []).push(cb);
        }),
        removeEventListener: jest.fn(),
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    emit = (data: unknown) => (listeners['message'] || []).forEach((cb) => cb({ data }));
}

const origEnv = process.env.NODE_ENV;

beforeEach(async () => {
    (process.env as { NODE_ENV: string }).NODE_ENV = 'production';
    drained.mockReset();
    recreated.mockReset();
    installSwMock();
    render(<ServiceWorkerRegistrar />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
});

afterEach(() => {
    (process.env as { NODE_ENV: string }).NODE_ENV = origEnv as string;
});

describe('the registrar routes what the worker sends', () => {
    it('a drained queue refreshes the pending count', async () => {
        // #740. Without this the count keeps claiming work is on the phone.
        await act(async () => emit({ type: 'outbox-flushed', rateLimited: false }));
        expect(drained).toHaveBeenCalledTimes(1);
        expect(recreated).not.toHaveBeenCalled();
    });

    it('a rebuilt database reports the eviction', async () => {
        await act(async () => emit({ type: 'outbox-db-recreated' }));
        expect(recreated).toHaveBeenCalledTimes(1);
        expect(drained).not.toHaveBeenCalled();
    });

    it('the two are not confused for one another', async () => {
        // They mean opposite things — "your work arrived" vs "your work was
        // deleted". Routing either to the other's handler would be worse than
        // ignoring both.
        await act(async () => {
            emit({ type: 'outbox-flushed' });
            emit({ type: 'outbox-db-recreated' });
        });
        expect(drained).toHaveBeenCalledTimes(1);
        expect(recreated).toHaveBeenCalledTimes(1);
    });

    it('ignores messages it does not own, and malformed ones', async () => {
        // The worker also posts SKIP_WAITING-adjacent traffic, and other
        // libraries can post anything at all. A handler that threw here would
        // take out the effect for every later message.
        await act(async () => {
            emit({ type: 'something-else' });
            emit(null);
            emit(undefined);
            emit('a string');
        });
        expect(drained).not.toHaveBeenCalled();
        expect(recreated).not.toHaveBeenCalled();
    });
});
