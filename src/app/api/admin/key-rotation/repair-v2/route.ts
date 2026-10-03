/**
 * Repair MISPLACED `v2:` ciphertext — rows encrypted under a tenant DEK on a
 * model that should only ever use the global KEK.
 *
 * ── why this route exists, and why it is separate from its parent ──
 *
 * `repairMisplacedV2` shipped in #1248 with tests and **no caller**: defined,
 * proven, and unreachable from production. That is the defect this codebase
 * names "wired is not delivered", and it would have left me with a migration I
 * could not run against the two live rows it was written for.
 *
 * It is its OWN path rather than a flag on `POST /api/admin/key-rotation`
 * because it is a different operation. The parent sweeps ciphertext onto the
 * current master KEK — a rotation step. This fixes rows whose KEY CHOICE was
 * wrong, which is not part of a rotation and must not happen as a side effect
 * of one: a routine rotation that silently rewrote rows for an unrelated reason
 * would be a surprise in the worst place.
 *
 * The Edge already admits it — `'/api/admin/key-rotation/'` is in
 * `PUBLIC_PATH_PREFIXES` as the children prefix of the parent's exact entry, so
 * no new opening was needed and none was made.
 *
 * ── it does NOT gate `previousKeyRetirable` ──
 *
 * Deliberately. A misplaced `v2:` row is encrypted under a tenant DEK, and that
 * DEK is re-wrapped under the new KEK by the rotation sweep — so the row stays
 * decryptable and the previous KEK can still be retired with work outstanding
 * here. Two independent problems; conflating their signals would block a
 * rotation on something unrelated to it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { repairMisplacedV2, countMisplacedV2 } from '@/app-layer/usecases/global-key-rotation';
import { appendPlatformAuditEntry } from '@/lib/audit/platform-audit-writer';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
/** Each row is a DEK fetch plus two AES operations; the 15s default is short. */
export const maxDuration = 300;

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

/** How many misplaced `v2:` values remain. Read-only. */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    const misplaced = await countMisplacedV2();
    return jsonResponse({
        misplacedV2: misplaced,
        /**
         * Named for the decision rather than the measurement. `true` means
         * every global-KEK model's ciphertext is on the global KEK, so no
         * reader is holding a row it cannot decrypt.
         */
        repairComplete: misplaced === 0,
    });
});

/**
 * Run the repair. Idempotent — a value already `v1:` is not selected at all,
 * so a second call reports zero repaired.
 */
export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const perColumn = await repairMisplacedV2();
        const sum = (f: (r: (typeof perColumn)[number]) => number): number =>
            perColumn.reduce((a, r) => a + f(r), 0);
        const remaining = await countMisplacedV2();

        // P1.9 — a platform action with no audit trail. This rewrites
        // ciphertext on rows nobody else can read; the chain is what lets
        // someone later establish WHEN it ran and over how many rows, without
        // relying on a log line that rotation can age out.
        //
        // AFTER the work, not before: an entry claiming a repair that then
        // failed is worse than no entry. The totals are what make it useful.
        await appendPlatformAuditEntry({
            scope: 'key-rotation',
            action: 'KEY_ROTATION_V2_REPAIRED',
            requestId: req.headers.get('x-request-id'),
            detailsJson: {
                totalFound: sum((r) => r.found),
                totalRepaired: sum((r) => r.repaired),
                totalErrors: sum((r) => r.errors),
                remainingAfter: remaining,
                perColumn,
            },
        });

        return jsonResponse({
            perColumn,
            totalFound: sum((r) => r.found),
            totalRepaired: sum((r) => r.repaired),
            totalErrors: sum((r) => r.errors),
            misplacedV2: remaining,
            repairComplete: remaining === 0,
        });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-v2-repair' } },
);
