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
import { appendPlatformAuditEntry } from '@/lib/audit/platform-audit-writer';
import { PlatformAuditAction } from '@prisma/client';
import { logger } from '@/lib/observability/logger';
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

        /**
         * Append to the `key-rotation` chain (P1.9).
         *
         * This is the class of action that chain was built for: it rewrites
         * `emailHash` on every `User` row, and the operator then DELETES a key
         * on the strength of the verdict below. Without an entry there is no
         * record of who swept, when, or what the verdict said at the moment the
         * key was retired.
         *
         * The `key-rotation` scope rather than a `lookup-rehash` one of its
         * own: both are steps in retiring a key, an operator reads them as one
         * history, and a second chain verifies cleanly while the history you
         * meant to append to looks untouched.
         *
         * The audit write does NOT fail the response. The sweep has already
         * COMMITTED by this point — rows are rewritten — so throwing here would
         * report a failure over work that succeeded, and an operator would
         * re-run a pass that had nothing left to do. The failure is logged at
         * error level instead, and `verifyPlatformChain` reports a gap as a
         * gap rather than as tampering.
         */
        try {
            await appendPlatformAuditEntry({
                scope: 'key-rotation',
                action: PlatformAuditAction.LOOKUP_HASH_REHASHED,
                detailsJson: {
                    totalScanned: sum((r) => r.scanned),
                    totalRehashed: sum((r) => r.rehashed),
                    totalAlreadyCurrent: sum((r) => r.alreadyCurrent),
                    totalErrors: sum((r) => r.errors),
                    collisionCount: perColumn.reduce((a, r) => a + r.collisions.length, 0),
                    staleAfter: verdict.stale,
                    undecryptableAfter: verdict.undecryptable,
                    previousKeyRetirable: verdict.retirable,
                    batchSize: body.batchSize ?? null,
                },
            });
        } catch (err) {
            logger.error('lookup-rehash.audit_append_failed', {
                component: 'lookup-rehash',
                error: err instanceof Error ? err.message : 'unknown',
            });
        }

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
