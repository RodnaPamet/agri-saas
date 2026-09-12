/**
 * GET /api/offline/whoami
 *
 * The authoritative answer to "who is signed in ON THIS DEVICE, right now?"
 *
 * ## Why this exists rather than reading the value the app already has
 *
 * `getCurrentUserId()` looks like the answer and is not. `setCurrentUserId`
 * has exactly one caller (`src/app/providers.tsx`), fed from the
 * server-rendered root layout — so the value is a property of the DOCUMENT,
 * not of the session. `public/sw.js` caches every ok navigation into
 * `PAGE_CACHE` and replays it on a fetch throw, and its shell fallback serves
 * the most recent cached document for an eligible launch URL. On a shared
 * phone that can hand operator B a document rendered for operator A.
 *
 * Two open defects need an answer that survives that:
 *   • #930 — an auth-parked write can never be unblocked, because nothing can
 *     safely decide that the session which was refused is now good.
 *   • #932 — the service-worker drain has no attribution concept at all
 *     (`queuedByUserId` appears zero times in `public/sw.js`), so on a shared
 *     device it replays A's queued work under B's cookie, into an append-only
 *     hash-chained audit trail.
 *
 * Both need a verified id, and neither can trust a rendered page for it.
 *
 * ## The three answers, and why the third is not the second
 *
 *   200 { userId }  — verified. The server accepted THIS request's credential.
 *   401 / 403       — DEFINITE: not signed in, or refused.
 *   anything else   — UNKNOWN. A 5xx, a network throw, a captive portal
 *                     answering 200 with HTML, a 426 from the version gate.
 *
 * Callers must not collapse the third into the second. `src/middleware.ts`
 * records the rule this follows: "The bug was never the fail-open on an
 * UNKNOWN answer — it was ignoring a DEFINITE one." Treating unknown as
 * signed-out would hold an operator's queued work on-device indefinitely,
 * trading a mis-attributed write for a lost one.
 *
 * ## Cacheability is load-bearing
 *
 * A cached answer is exactly the defect this endpoint exists to escape, so it
 * is `no-store` AND deliberately outside every path `public/sw.js` caches: the
 * worker's fetch handler leaves any `/api/` GET that is neither
 * `isBasemapRequest` nor `isFieldDataRequest` network-only, and this path
 * matches neither. Do not add it to either predicate.
 *
 * Authentication is the middleware's: an unauthenticated API route is answered
 * with 401 JSON (not a redirect to /login), which is what makes the DEFINITE
 * signal definite. `auth()` rather than `getServerSession` because a native
 * client holds a bearer, not a cookie.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';

export const dynamic = 'force-dynamic';

export const GET = withApiErrorHandling(async () => {
    const session = await auth();
    const userId = session?.user?.id ?? null;

    if (!userId) {
        // Reached only if the middleware let the request through without a
        // usable identity. Answer DEFINITELY rather than 200-with-null, so a
        // caller never reads "signed out" as "verified as nobody".
        return NextResponse.json(
            { error: { code: 'UNAUTHENTICATED', message: 'Not signed in.' } },
            { status: 401, headers: { 'Cache-Control': 'no-store' } },
        );
    }

    return NextResponse.json(
        { userId },
        {
            // Never cached, anywhere. A stale answer here re-creates the exact
            // document-vs-session confusion the endpoint exists to escape.
            headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
        },
    );
});
