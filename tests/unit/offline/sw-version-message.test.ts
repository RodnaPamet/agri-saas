/**
 * The service worker ANSWERS "which revision are you?" — executed, not grepped.
 *
 * `tests/guards/sw-revision-stamp.test.ts` asserts the source text; this runs
 * the real `public/sw.js` and drives its message handler, because a guard that
 * matches a regex cannot tell a wired arm from a commented-out one.
 *
 * Why the question needs asking at all: install deliberately skips
 * `skipWaiting` — "a deploy mid-field-session must not hot-swap the SW under an
 * operator who's mid-queue on flaky signal" — so the new worker parks in
 * 'waiting' until the operator consents, with NO upper bound. A device can run
 * a months-old worker and nothing measures it. The page cannot otherwise learn
 * which one is running.
 *
 * The reply must stay READ-ONLY. Activating the waiting worker is the
 * operator's consent to give, and answering a question is not consent.
 */
import fs from 'node:fs';
import path from 'node:path';

const SW_SRC = fs.readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');

type Handler = (event: unknown) => void;

/** Load the real worker with a `self` double that records its listeners. */
function loadWorker() {
    const handlers: Record<string, Handler> = {};
    const skipWaiting = jest.fn();
    const self: Record<string, unknown> = {
        addEventListener: (type: string, fn: Handler) => {
            handlers[type] = fn;
        },
        skipWaiting,
        registration: { scope: '/', showNotification: jest.fn() },
        clients: { matchAll: async () => [], claim: jest.fn() },
        location: { origin: 'https://app.agrent.bg' },
    };
    const noop = () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const factory = new Function(
        'self', 'indexedDB', 'caches', 'fetch', 'Response', 'Request', 'URL', 'clients', 'console',
        `${SW_SRC}\nreturn { SW_REVISION: typeof SW_REVISION !== 'undefined' ? SW_REVISION : null };`,
    );
    const exports_ = factory(
        self,
        { open: noop },
        { open: noop, keys: async () => [], match: async () => undefined },
        noop,
        function Response() {},
        function Request() {},
        URL,
        self.clients,
        { log: noop, warn: noop, error: noop },
    ) as { SW_REVISION: string | null };
    return { handlers, skipWaiting, revision: exports_.SW_REVISION };
}

describe('public/sw.js — the SW_VERSION message', () => {
    it('replies with its own revision', () => {
        const { handlers, revision } = loadWorker();
        expect(typeof revision).toBe('string');

        const postMessage = jest.fn();
        handlers.message({ data: { type: 'SW_VERSION' }, source: { postMessage } });

        expect(postMessage).toHaveBeenCalledWith({ type: 'SW_VERSION', revision });
    });

    it('does NOT activate the waiting worker to answer', () => {
        const { handlers, skipWaiting } = loadWorker();
        handlers.message({ data: { type: 'SW_VERSION' }, source: { postMessage: jest.fn() } });
        expect(skipWaiting).not.toHaveBeenCalled();
    });

    // CONTROL — the arm that IS allowed to activate still does, or "never
    // skipWaiting" would be satisfied by a worker that can never update.
    it('CONTROL: SKIP_WAITING still activates', () => {
        const { handlers, skipWaiting } = loadWorker();
        handlers.message({ data: { type: 'SKIP_WAITING' } });
        expect(skipWaiting).toHaveBeenCalled();
    });

    // CONTROL — an unrelated message must not draw a version reply.
    it('CONTROL: another message type gets no version reply', () => {
        const { handlers } = loadWorker();
        const postMessage = jest.fn();
        handlers.message({ data: { type: 'something-else' }, source: { postMessage } });
        expect(postMessage).not.toHaveBeenCalled();
    });

    // A message with no source must not throw — the worker handles messages
    // from contexts that cannot be replied to.
    it('tolerates a SW_VERSION message with no source', () => {
        const { handlers } = loadWorker();
        expect(() => handlers.message({ data: { type: 'SW_VERSION' } })).not.toThrow();
    });
});
