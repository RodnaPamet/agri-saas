/**
 * The whoami probe reports THREE outcomes, and never collapses two of them.
 *
 * `getCurrentUserId()` cannot answer "who is signed in": `setCurrentUserId`
 * is fed from the server-rendered layout, so the value belongs to the
 * DOCUMENT, and `public/sw.js` replays cached documents — on a shared phone
 * the shell fallback can hand operator B a page rendered for A. #930 (an
 * auth-parked write that can never be unblocked) and #932 (the SW drain
 * attributing A's work to B) both need an answer that survives that.
 *
 * WHY THE THIRD OUTCOME IS THE POINT. A caller that reads "unknown" as
 * "signed out" holds an operator's queued work on-device indefinitely —
 * trading a mis-attributed write for a lost one. A caller that reads it as
 * "verified" sends under the wrong identity. `src/middleware.ts` states the
 * rule this follows: "The bug was never the fail-open on an UNKNOWN answer —
 * it was ignoring a DEFINITE one."
 *
 * So the cases below are mostly about what must NOT be called signed-out: a
 * 502, a captive portal answering 200 with HTML, a timeout, a JSON body with
 * no id. Each is a different fact from a 401.
 */
import { resolveWhoami, WHOAMI_PATH } from '@/lib/offline/whoami';

function jsonResponse(body: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
        json: async () => body,
    } as unknown as Response;
}

function htmlResponse(status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
        json: async () => {
            throw new SyntaxError('Unexpected token <');
        },
    } as unknown as Response;
}

describe('resolveWhoami — a verified identity', () => {
    it('reports the user id the SERVER returned', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ userId: 'user-1' }));
        await expect(resolveWhoami(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
            kind: 'user',
            userId: 'user-1',
        });
    });

    it('asks the right path, uncached, with credentials', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ userId: 'user-1' }));
        await resolveWhoami(fetchImpl as unknown as typeof fetch);

        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(WHOAMI_PATH);
        // A cached answer is precisely the defect the probe exists to escape.
        expect(init.cache).toBe('no-store');
        expect(init.credentials).toBe('same-origin');
    });
});

describe('resolveWhoami — a DEFINITE refusal', () => {
    it.each([401, 403])('reports signed-out on %i', async (status) => {
        const fetchImpl = jest.fn(async () => jsonResponse({}, status));
        await expect(resolveWhoami(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
            kind: 'signed-out',
        });
    });
});

describe('resolveWhoami — everything else is UNKNOWN, not signed-out', () => {
    // The whole reason the type has three members.
    it.each([500, 502, 503, 429, 426, 404])('status %i is unknown', async (status) => {
        const fetchImpl = jest.fn(async () => jsonResponse({}, status));
        const res = await resolveWhoami(fetchImpl as unknown as typeof fetch);
        expect(res.kind).toBe('unknown');
        expect(res).not.toEqual({ kind: 'signed-out' });
    });

    it('a captive portal answering 200 with HTML is unknown', async () => {
        const fetchImpl = jest.fn(async () => htmlResponse(200));
        const res = await resolveWhoami(fetchImpl as unknown as typeof fetch);
        expect(res.kind).toBe('unknown');
        if (res.kind === 'unknown') expect(res.reason).toContain('content-type');
    });

    it('a 200 with JSON but no user id is unknown', async () => {
        const fetchImpl = jest.fn(async () => jsonResponse({ somethingElse: true }));
        const res = await resolveWhoami(fetchImpl as unknown as typeof fetch);
        expect(res.kind).toBe('unknown');
    });

    it('a network throw is unknown — a request never answered has not been refused', async () => {
        const fetchImpl = jest.fn(async () => {
            throw new TypeError('Load failed');
        });
        const res = await resolveWhoami(fetchImpl as unknown as typeof fetch);
        expect(res.kind).toBe('unknown');
        expect(res).not.toEqual({ kind: 'signed-out' });
    });

    it('never throws — a caller forced to try/catch will treat the catch as signed-out', async () => {
        const fetchImpl = jest.fn(async () => {
            throw new Error('boom');
        });
        await expect(resolveWhoami(fetchImpl as unknown as typeof fetch)).resolves.toBeDefined();
    });

    it('times out rather than hanging a drain on a dead network', async () => {
        const fetchImpl = jest.fn(
            (_u: string, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                }),
        );
        const res = await resolveWhoami(fetchImpl as unknown as typeof fetch, 20);
        expect(res.kind).toBe('unknown');
        if (res.kind === 'unknown') expect(res.reason).toContain('AbortError');
    });
});
