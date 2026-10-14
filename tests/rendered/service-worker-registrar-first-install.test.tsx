/** @jest-environment jsdom */
/**
 * ServiceWorkerRegistrar — a FIRST install must not reload the page (#1076).
 *
 * ## The defect
 *
 * `controllerchange` fires in two unrelated situations and the listener treated
 * them alike:
 *
 *   1. a new worker took over after the operator consented (SKIP_WAITING) —
 *      the page is now running superseded assets and a reload is correct;
 *   2. the FIRST worker activated and called `self.clients.claim()` — the page
 *      was served by the network, its assets are current, and a reload throws
 *      away whatever the operator had typed.
 *
 * `public/sw.js`'s `activate` handler calls `self.clients.claim()`
 * unconditionally. `install` deliberately skips `skipWaiting`, which is what
 * makes an UPDATE wait for consent — but on a first visit there is no incumbent
 * to wait for, so the worker activates and claims immediately. So case 2 fired
 * on every first visit in production.
 *
 * The mechanism is confirmed rather than inferred: it is the cause recorded for
 * #1329 in `tests/e2e/known-flakes.json`, identified 2026-10-11 after it had
 * produced three different symptoms in `theme-first-paint.spec.ts` — a null
 * FCP, a destroyed execution context, and finally a confidently WRONG mutation
 * count, because the reloaded document legitimately needed no theme correction.
 *
 * ## Why no existing test caught it
 *
 * Both sibling suites hardcode `controller: {}` in their service-worker double,
 * commented "non-null → the prompt is an update, not a first install". That is
 * the right setup for what they test and it means the uncontrolled world — the
 * one every new visitor is in — had no coverage at all.
 *
 * ## How a reload is observed here
 *
 * `location.reload` cannot be spied in this jsdom: `window.location` is
 * non-configurable and `reload` is a non-configurable read-only own property.
 * The sibling suites therefore assert the WIRING and not the terminal call.
 *
 * This suite needs the opposite — whether the call happened — so it counts the
 * `Not implemented: navigation` jsdomError that `location.reload()` raises.
 * That channel is only trustworthy with a POSITIVE CONTROL, because a counter
 * that is broken and a reload that correctly did not happen both read as zero.
 * So every "did not reload" case here is paired with a case that DOES reload
 * through the same counter.
 */
import { render, act } from '@testing-library/react';

// Per-suite factory, so `useLocale` has to be carried too — the project-wide
// mock in tests/rendered/setup.ts is replaced wholesale, not merged.
jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));
jest.mock('@/components/pwa/InstallPrompt', () => ({ InstallPrompt: () => null }));

import { ServiceWorkerRegistrar } from '@/components/pwa/ServiceWorkerRegistrar';

type SwDouble = {
    controller: object | null;
    _emit: (type: string) => void;
};

/**
 * `controller` is the whole variable under test: `null` is a first visit (the
 * page is uncontrolled), an object is any later visit.
 */
function installSwMock(controller: object | null): SwDouble {
    const reg = { waiting: null, installing: null, addEventListener: jest.fn() };
    const swListeners: Record<string, Array<() => void>> = {};
    const serviceWorker = {
        controller,
        register: jest.fn(() => Promise.resolve(reg)),
        getRegistration: jest.fn(() => Promise.resolve(reg)),
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
    return serviceWorker as unknown as SwDouble;
}

async function mountAndSettle() {
    render(<ServiceWorkerRegistrar />);
    // Let register()'s promise chain drain, so the mount is in the same state
    // it would be in when a real `controllerchange` arrives.
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

let navigations = 0;
let errorSpy: jest.SpyInstance;
const origEnv = process.env.NODE_ENV;

beforeEach(() => {
    // The whole effect is production-gated, so without this the listener is
    // never even attached and every case here would pass vacuously.
    (process.env as { NODE_ENV: string }).NODE_ENV = 'production';
    navigations = 0;
    errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).includes('Not implemented: navigation')) {
            navigations += 1;
            return;
        }
        process.stderr.write(String(args[0]) + '\n');
    });
});

afterEach(() => {
    errorSpy.mockRestore();
    (process.env as { NODE_ENV: string | undefined }).NODE_ENV = origEnv;
});

describe('a first install does not reload the page', () => {
    it('an uncontrolled page ignores the first claim', async () => {
        const sw = installSwMock(null);
        await mountAndSettle();

        act(() => sw._emit('controllerchange'));

        expect(navigations).toBe(0);
    });

    it('POSITIVE CONTROL: a page that WAS controlled still reloads', async () => {
        // Without this, the case above passes just as well with the counter
        // wired to nothing — which is the only reason it is trustworthy.
        const sw = installSwMock({});
        await mountAndSettle();

        act(() => sw._emit('controllerchange'));

        expect(navigations).toBe(1);
    });

    it('the verdict is captured at MOUNT, not read when the event fires', async () => {
        const sw = installSwMock(null);
        await mountAndSettle();

        // What the browser actually does: the worker claims the page, so
        // `navigator.serviceWorker.controller` becomes non-null, and THEN the
        // event fires. A guard that reads `controller` inside the handler sees
        // a non-null value in both worlds and reloads anyway — it looks like a
        // fix and is not one. This is the case that distinguishes them.
        (sw as unknown as { controller: object }).controller = {};
        act(() => sw._emit('controllerchange'));

        expect(navigations).toBe(0);
    });

    it('still reloads only ONCE when a controlled page gets two events', async () => {
        const sw = installSwMock({});
        await mountAndSettle();

        act(() => sw._emit('controllerchange'));
        act(() => sw._emit('controllerchange'));

        // `reloadedRef` is shared across every trigger; the guard must not have
        // disturbed that collapse.
        expect(navigations).toBe(1);
    });

    it('does nothing at all outside production', async () => {
        (process.env as { NODE_ENV: string }).NODE_ENV = 'development';
        const sw = installSwMock({});
        await mountAndSettle();

        act(() => sw._emit('controllerchange'));

        // The dev gate is why a SW never fights HMR. Asserted against the
        // CONTROLLED double, so this case would fail if the gate were removed
        // rather than passing for the same reason as the first-install cases.
        expect(navigations).toBe(0);
    });
});
