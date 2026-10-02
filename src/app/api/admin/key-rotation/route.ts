/**
 * Platform-level master-KEK rotation: the global-column sweep and its
 * completion signal.
 *
 * `POST /api/t/{slug}/admin/key-rotation` already exists and is tenant-scoped.
 * This is the other half — the columns that have no tenant to be scoped by, and
 * the PII manifest the tenant job has never heard of. See
 * `@/app-layer/usecases/global-key-rotation` for why that gap exists and what
 * it measured on production.
 *
 * ── GET is the one an operator needs most ──
 *
 * It answers "may I remove `DATA_ENCRYPTION_KEY_PREVIOUS` yet?", which was
 * previously unanswerable: `encryptField` emits `v1:`, so a migrated row is
 * still `v1:` and the documented instruction — "remove it once every tenant
 * reports zero v1 rows" — names a count that never reaches zero. GET reports
 * how many v1 values are not yet readable under the PRIMARY key, which is the
 * question that actually has an end state.
 *
 * ── gate ──
 *
 * `X-Platform-Admin-Key`, like the rest of `/api/admin/*`. A rotation sweep
 * re-encrypts every PII column in the deployment; it is not a tenant-scoped
 * permission and there is no user session during an operator rotation. The Edge
 * refuses an `x-platform-admin-key` request unless the path is public (the
 * SCIM / `iflk_` / signed-webhook shape, seven prior instances), so both
 * methods are opened in `src/lib/auth/guard.ts` and the handler authenticates
 * itself.
 *
 * ── it is a loop, not a job ──
 *
 * Deliberately synchronous and batched rather than a BullMQ job: an operator
 * mid-rotation wants to SEE progress and decide when to stop, and a background
 * job's completion is one more thing to go and check. Call POST until
 * `remaining` is 0. Each call is idempotent — a row already under the primary
 * key is counted and left alone.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import {
    sweepGlobalKeyRotation,
    countUnmigrated,
    countUnwrappedDeks,
    countMisplacedV2,
    sweepableColumns,
} from '@/app-layer/usecases/global-key-rotation';
import { kekRotationInFlight } from '@/lib/security/encryption';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
/** A sweep is AES work per row; the default 15s would cut a real run short. */
export const maxDuration = 300;

const Body = z.object({
    /** Rows per SELECT. Bounded in the usecase too — this is the HTTP bound. */
    batchSize: z.number().int().min(1).max(2000).optional(),
    /**
     * Narrow the run to specific columns, e.g. to move
     * `Account.accessTokenEncrypted` (third-party OAuth credentials) first and
     * see it finish before committing to the rest. Capped because the list is
     * matched against the manifest union, not used to discover work.
     *
     * A filter that matches no column is REFUSED, not quietly run over nothing.
     * The response's `filtered` flag is then load-bearing: a scoped run's
     * `remaining: 0` says "these columns are done", never "the previous key is
     * retirable".
     */
    only: z
        .array(z.object({ model: z.string().min(1).max(64), column: z.string().min(1).max(64) }))
        .max(64)
        .optional(),
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

/** How much is left, and therefore whether `_PREVIOUS` may be retired. */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    // `?only=Model.column` (repeatable) narrows the report the same way POST
    // narrows the work, so an operator can watch one column drain.
    const only = req.nextUrl.searchParams
        .getAll('only')
        .map((pair) => pair.split('.'))
        .filter((parts) => parts.length === 2)
        .map(([model, column]) => ({ model, column }));
    const { total, perColumn } = await countUnmigrated(only.length > 0 ? only : undefined);
    // The wrapped tenant DEKs are master-KEK ciphertext in NEITHER manifest, so
    // the column union does not reach them. Leaving them out of the verdict is
    // how `previousKeyRetirable` could have said yes while every DEK still
    // needed the old key — see the usecase's DEK_COLUMNS docblock. Counted only
    // for an UNFILTERED report, since a filtered one is a claim about columns.
    const unwrappedDeks = only.length > 0 ? 0 : await countUnwrappedDeks();
    // Reported so the work is DISCOVERABLE from the surface an operator already
    // reads — but deliberately NOT part of `remaining` or
    // `previousKeyRetirable`. A misplaced v2 row is encrypted under a tenant
    // DEK, which the rotation re-wraps, so it stays decryptable and does not
    // block retiring the previous key. Separate problem, separate signal; the
    // repair lives at ./repair-v2.
    const misplacedV2 = only.length > 0 ? 0 : await countMisplacedV2();
    return jsonResponse({
        rotationInFlight: kekRotationInFlight(),
        filtered: only.length > 0,
        remaining: total + unwrappedDeks,
        columnsRemaining: total,
        unwrappedDeks,
        misplacedV2,
        /**
         * The whole point of the field: `true` means every master-KEK
         * ciphertext in the deployment is readable under the CURRENT key, so
         * `DATA_ENCRYPTION_KEY_PREVIOUS` can be removed. Named for the decision
         * rather than the measurement, because the measurement is what was
         * previously misread.
         *
         * NEVER true for a filtered report: "these columns are done" is not
         * the same claim, and conflating them is how a previous key gets
         * dropped while something still needs it.
         */
        previousKeyRetirable: only.length === 0 && total === 0 && unwrappedDeks === 0,
        columns: perColumn,
    });
});

/** Run one sweep pass. Call until `remaining` is 0. */
export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        let raw: unknown = {};
        try {
            const text = await req.text();
            if (text.trim().length > 0) raw = JSON.parse(text);
        } catch {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }
        const body = Body.parse(raw);

        const result = await sweepGlobalKeyRotation({ batchSize: body.batchSize, only: body.only });
        return jsonResponse({
            ...result,
            previousKeyRetirable: result.remaining === 0,
            /** Surfaced so an operator can see the union is both manifests. */
            manifests: [...new Set(sweepableColumns().map((c) => c.manifest))].sort(),
        });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-global-key-rotation' } },
);
