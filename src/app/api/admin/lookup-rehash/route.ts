/**
 * Run and inspect the lookup-hash rehash sweep. #1237, P1.3.
 *
 * ── why this route exists ──
 *
 * `rehashLookupHashes` without a caller is a migration nobody can run. That
 * mistake shipped once in this codebase already — `repairMisplacedV2` landed
 * with tests and no invoker, on two live rows it was written for — so the
 * sweep and its door land together.
 *
 * ── the shape mirrors /api/admin/key-rotation deliberately ──
 *
 * GET answers the operator's actual question, "may I remove
 * `LOOKUP_HMAC_KEY_PREVIOUS` yet", and POST does one pass. An operator running
 * this follows the same loop as the KEK rotation: POST until GET says
 * retirable, then remove the variable. Keeping the two surfaces the same shape
 * means the runbook reads the same way.
 *
 * ── it is NOT part of the KEK rotation surface ──
 *
 * Its own path rather than another child of `/api/admin/key-rotation/`, because
 * these are different keys with different consequences. Rotating the master KEK
 * moves ciphertext and leaves hashes alone; rotating the LOOKUP key moves
 * hashes and leaves ciphertext alone. Running one when you meant the other is
 * the mistake worth making structurally harder.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import {
    rehashLookupHashes,
    countStaleLookupHashes,
    lookupPreviousKeyRetirable,
} from '@/app-layer/usecases/lookup-rehash';
import { isLookupKeyPinned } from '@/lib/security/encryption';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
/** A decrypt plus an HMAC per row; the 15s default is far too short. */
export const maxDuration = 300;

const Body = z.object({
    /** Rows per keyset page. Bounded in the usecase as well. */
    batchSize: z.number().int().min(1).max(5000).optional(),
});

function platformGate(req: NextRequest): NextResponse | null {
    try {
        verifyPlatformApiKey(req);
        return null;
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
}

/** How much is outstanding, and may the previous key go. Read-only. */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    // ONE scan, two answers. Every row in scope is decrypted to compute this,
    // so handing the counts to the verdict rather than letting it re-scan is
    // the difference between decrypting the user table once and twice.
    const counts = await countStaleLookupHashes();
    const verdict = await lookupPreviousKeyRetirable(counts);

    return jsonResponse({
        /**
         * Surfaced because it changes what every number below MEANS. With no
         * pinned lookup key the hashes derive from the KEK and nothing can be
         * stale — a `stale: 0` then says "not applicable", not "finished".
         */
        lookupKeyPinned: isLookupKeyPinned(),
        total: counts.total,
        stale: counts.stale,
        perColumn: counts.perColumn,
        /**
         * The only question an operator is really asking. False while anything
         * is stale OR undecryptable — see the usecase for why the second term
         * cannot be dropped.
         */
        previousKeyRetirable: verdict.retirable,
        undecryptable: verdict.undecryptable,
    });
});

/** One pass. Idempotent — a row already current is skipped. */
export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        let raw: unknown = {};
        try {
            const text = await req.text();
            if (text) raw = JSON.parse(text);
        } catch {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }
        const body = Body.parse(raw);

        const perColumn = await rehashLookupHashes({ batchSize: body.batchSize });
        const sum = (f: (r: (typeof perColumn)[number]) => number): number =>
            perColumn.reduce((a, r) => a + f(r), 0);

        // Re-READ rather than deriving from the pass's own totals. A row whose
        // UPDATE collided is still stale, and `scanned - rehashed` would report
        // it as finished.
        const verdict = await lookupPreviousKeyRetirable();

        return jsonResponse({
            perColumn,
            totalScanned: sum((r) => r.scanned),
            totalRehashed: sum((r) => r.rehashed),
            totalAlreadyCurrent: sum((r) => r.alreadyCurrent),
            totalErrors: sum((r) => r.errors),
            /**
             * Row ids whose rehash hit the unique constraint. Each one means
             * TWO rows claim one address — the duplicate-`User` defect #1237
             * exists to prevent — and needs a human, not a retry.
             */
            collisions: perColumn.flatMap((r) => r.collisions),
            stale: verdict.stale,
            undecryptable: verdict.undecryptable,
            previousKeyRetirable: verdict.retirable,
        });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-lookup-rehash' } },
);
