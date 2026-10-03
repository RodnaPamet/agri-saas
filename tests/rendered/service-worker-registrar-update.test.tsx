/** @jest-environment jsdom */
/**
 * ServiceWorkerRegistrar — the consent-gated update path.
 *
 * Regression cover for the production bug where the "Update ready — refresh"
 * banner's button "did nothing on click". The naive implementation posted
 * SKIP_WAITING to a CAPTURED worker ref and waited solely for
 * `controllerchange` to reload. Two real failure modes made the tap a dead
 * end:
 *   1. a STALE ref — on a busy deploy a newer worker supersedes the captured
 *      one, so postMessage hits a `redundant` worker and is a silent no-op;
 *   2. `controllerchange` never firing (browser quirk, notably iOS Safari),
 *      so the page never reloaded even when skipWaiting succeeded.
 *
 * These tests assert the hardened behaviour: the tap targets the LIVE
 * `reg.waiting` and the page reloads on the new worker's own `activated`
 * statechange — no `controllerchange` required.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';

// P2.1c — `useLocale` added: it is part of this module, and without it the
// first component calling `useDateFormat()` threw "useLocale is not a
// function". The project-wide mock in tests/rendered/setup.ts already
// provides it; a per-suite factory replaces that wholesale, so each one
// has to carry it too.
jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));
jest.mock('@/components/pwa/InstallPrompt', () => ({ InstallPrompt: () => null }));

import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';

type FakeWorker = ServiceWorker & {
    _emitStateChange: (state: string) => void;
    postMessage: jest.Mock;
};

function makeWorker(state = 'installed'): FakeWorker {
    const listeners: Record<string, Array<() => void>> = {};
    const worker = {
        state,
        postMessage: jest.fn(),
        addEventListener: jest.fn((type: string, cb: () => void) => {
            (listeners[type] ||= []).push(cb);
        }),
        _emitStateChange(next: string) {
            (worker as unknown as { state: string }).state = next;
            (listeners['statechange'] || []).forEach((cb) => cb());
        },
    };
    return worker as unknown as FakeWorker;
}

function installSwMock(opts: { captured: FakeWorker; live?: FakeWorker }) {
    const reg = {
        waiting: opts.captured,
        installing: null,
        addEventListener: jest.fn(),
    };
    // getRegistration resolves the LIVE registration — its `waiting` may differ
    // from the one captured at register() time (the stale-ref case).
    const liveReg = { waiting: opts.live ?? opts.captured };
    const swListeners: Record<string, Array<() => void>> = {};
    const serviceWorker = {
        controller: {}, // non-null → the prompt is an update, not a first install
        register: jest.fn(() => Promise.resolve(reg)),
        getRegistration: jest.fn(() => Promise.resolve(liveReg)),
        ready: Promise.resolve(reg),
        addEventListener: jest.fn((type: string, cb: () => void) => {
            (swListeners[type] ||= []).push(cb);
        }),
        removeEventListener: jest.fn(),
        _emit(type: string) {
            (swListeners[type] || []).forEach((cb) => cb());
        },
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: serviceWorker,
    });
    return { serviceWorker };
}

// Mount + let register()'s promise resolve so `waiting` is captured and the
// banner renders. Microtasks flush under fake timers; the promise machinery
// isn't faked.
async function mountAndSettle() {
    render(<ServiceWorkerRegistrar />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// jsdom (this version) makes `window.location` non-configurable AND
// `location.reload` a non-configurable, read-only own property — it cannot be
// spied, redefined, or reassigned. So these tests assert the WIRING that the
// fix installs (the live-worker targeting, the `statechange`/`controllerchange`
// reload triggers, and the fallback timer) rather than the terminal
// `location.reload()` one-liner. The wiring is where the production bug lived;
// the reload call itself is exercised (for smoke-safety) but not counted.
describe('ServiceWorkerRegistrar — update apply path', () => {
    const origEnv = process.env.NODE_ENV;

    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        (process.env as { NODE_ENV: string }).NODE_ENV = 'production';
        jest.useFakeTimers();
        // Exercising the reload triggers calls jsdom's unimplemented
        // `location.reload()`, which logs a "Not implemented: navigation"
        // error. That's expected here — swallow only that message.
        errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            if (String(args[0]).includes('Not implemented: navigation')) return;
            process.stderr.write(String(args[0]) + '\n');
        });
    });

    afterEach(() => {
        errorSpy.mockRestore();
        jest.clearAllTimers();
        jest.useRealTimers();
        (process.env as { NODE_ENV: string }).NODE_ENV = origEnv as string;
    });

    it('posts SKIP_WAITING to the LIVE waiting worker, not a stale captured ref', async () => {
        const stale = makeWorker(); // captured at register() time
        const live = makeWorker(); // the current waiting worker at click time
        installSwMock({ captured: stale, live });

        await mountAndSettle();
        expect(screen.getByRole('status')).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
            await Promise.resolve();
            await Promise.resolve();
        });

        // The tap must reach the CURRENT waiting worker — messaging the stale
        // (possibly redundant) ref is the silent no-op that broke the button.
        expect(live.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
        expect(stale.postMessage).not.toHaveBeenCalled();
    });

    it('wires a browser-independent reload: statechange on the live worker + controllerchange fast path', async () => {
        const worker = makeWorker();
        const { serviceWorker } = installSwMock({ captured: worker });

        await mountAndSettle();
        expect(screen.getByRole('status')).toBeInTheDocument();

        // The fast path (may not fire on iOS Safari) is registered up front.
        expect(serviceWorker.addEventListener).toHaveBeenCalledWith(
            'controllerchange',
            expect.any(Function),
        );

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
            await Promise.resolve();
            await Promise.resolve();
        });

        // The reliable trigger: the new worker's own activation, independent of
        // controllerchange — this is what rescues browsers that never fire it.
        expect(worker.addEventListener).toHaveBeenCalledWith(
            'statechange',
            expect.any(Function),
        );

        // Exercising both triggers must run cleanly (reload path is a no-op
        // stub in jsdom) — no throw, whichever the browser delivers.
        expect(() => {
            act(() => worker._emitStateChange('activated'));
            act(() => serviceWorker._emit('controllerchange'));
        }).not.toThrow();
    });

    it('schedules a bounded fallback reload so the tap is never a dead end', async () => {
        const worker = makeWorker();
        installSwMock({ captured: worker });

        await mountAndSettle();
        expect(screen.getByRole('status')).toBeInTheDocument();

        const before = jest.getTimerCount();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
            await Promise.resolve();
            await Promise.resolve();
        });
        // A new timer (the fallback reload) is scheduled on tap …
        expect(jest.getTimerCount()).toBeGreaterThan(before);
        // … and firing it must not throw (reload is a jsdom no-op).
        expect(() => act(() => { jest.advanceTimersByTime(3000); })).not.toThrow();
    });
});
