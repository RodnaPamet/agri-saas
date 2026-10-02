import { getTenantCtx } from '@/app-layer/context';
import { markOperationParcel } from '@/app-layer/usecases/field-operation';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdateOperationParcelSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { parseIfMatch } from '@/lib/http/if-match';

export const PATCH = withApiErrorHandling(withValidatedBody(UpdateOperationParcelSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; taskId: string; lineId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // Optimistic lock — a mark queued offline replays with the row version it
    // saw as `If-Match`. A stale version → 409 STALE_DATA (the usecase throws).
    // #1182: a bare `parseInt` here COERCED `0abc` and `0x0` to 0 and accepted
    // `-1`, and fell through to UNGUARDED on `"5"`. Harmless in this design
    // because 0 is not a sentinel — and exactly why `farm-profile`, where 0
    // means "no row yet", refused to reuse it. One strict parser now serves
    // all three locked routes.
    const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
    const result = await markOperationParcel(ctx, params.taskId, params.lineId, body.status, body.note ?? undefined, expectedVersion);
    return jsonResponse(result);
}));
