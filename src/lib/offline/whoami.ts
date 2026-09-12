/**
 * Ask the SERVER who is signed in, and report three outcomes — never two.
 *
 * The page already has a user id, and it is not trustworthy for this:
 * `setCurrentUserId` is fed from the server-rendered layout, so the value
 * belongs to the DOCUMENT, and `public/sw.js` replays cached documents. On a
 * shared phone the shell fallback can hand operator B a page rendered for A.
 *
 * ## Why three outcomes
 *
 * Collapsing "unknown" into "signed out" is the defect this module exists to
 * avoid, and it is not hypothetical: a captive portal answers 200 with HTML,
 * a proxy answers 502, the version gate answers 426. Each is a DIFFERENT fact
 * from a 401, and `src/middleware.ts` already states the rule — "The bug was
 * never the fail-open on an UNKNOWN answer — it was ignoring a DEFINITE one."
 *
 * A caller that treats unknown as signed-out holds an operator's queued work
 * on-device indefinitely, trading a mis-attributed write for a lost one. A
 * caller that treats unknown as verified sends under the wrong identity.
 * Neither is acceptable, which is why the shape forces the caller to choose.
 */

/** A verified identity, a definite refusal, or no usable answer. */
export type WhoamiResult =
    | { kind: 'user'; userId: string }
    | { kind: 'signed-out' }
    | { kind: 'unknown'; reason: string };

export const WHOAMI_PATH = '/api/offline/whoami';

/** Bounded so a drain can never hang on a dead network. */
const TIMEOUT_MS = 5000;

/**
 * Resolve the current identity from the server.
 *
 * Never throws — a rejection is an `unknown`, because a caller forced to
 * try/catch will eventually treat the catch as "signed out".
 */
export async function resolveWhoami(
    fetchImpl: typeof fetch = fetch,
    timeoutMs = TIMEOUT_MS,
): Promise<WhoamiResult> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const res = await fetchImpl(WHOAMI_PATH, {
            method: 'GET',
            // `no-store` on both sides: the endpoint sets it, and this refuses
            // any HTTP cache that ignored it. A cached answer is the bug.
            cache: 'no-store',
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
            ...(controller ? { signal: controller.signal } : {}),
        });

        // DEFINITE. The server looked and said no.
        if (res.status === 401 || res.status === 403) return { kind: 'signed-out' };

        if (!res.ok) return { kind: 'unknown', reason: `status:${res.status}` };

        // A captive portal answers 200 with HTML. Checking the content type is
        // what separates "the server replied" from "something replied".
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('application/json')) {
            return { kind: 'unknown', reason: `content-type:${contentType || 'absent'}` };
        }

        const body = (await res.json().catch(() => null)) as { userId?: unknown } | null;
        if (!body || typeof body.userId !== 'string' || body.userId.length === 0) {
            return { kind: 'unknown', reason: 'body:no-user-id' };
        }
        return { kind: 'user', userId: body.userId };
    } catch (err) {
        // A throw is never a refusal — dead radio, aeroplane mode, an aborted
        // timeout. The same reasoning as `neverSent(status === 0)` in sync.ts:
        // a request that was never answered has not been refused.
        // Read `.name` off anything that carries one rather than gating on
        // `instanceof Error`: an AbortError arrives as a DOMException, which
        // is NOT an Error instance in every runtime this ships to, and losing
        // the name turns a diagnosable timeout into an anonymous failure.
        const name =
            typeof err === 'object' && err !== null && typeof (err as { name?: unknown }).name === 'string'
                ? (err as { name: string }).name
                : 'unknown';
        return { kind: 'unknown', reason: `throw:${name}` };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
