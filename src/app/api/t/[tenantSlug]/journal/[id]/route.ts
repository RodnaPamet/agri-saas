import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getLogEntry, updateLogEntry, deleteLogEntry } from '@/app-layer/usecases/journal';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdateLogEntrySchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'JOURNAL');
    const entry = await getLogEntry(ctx, params.id);
    return jsonResponse(entry);
});

/**
 * Journal edits WERE last-write-wins by decision. #919 revisited it, on the
 * trigger this very comment named — "journal edits start going through the
 * outbox" — and followed the OperationParcel precedent it pointed at:
 * `version Int`, `If-Match` here, a compare-and-swap guarded on version,
 * `staleData()` 409, and `ifMatch` on the outbox item.
 *
 * The paragraph below is kept as the RECORD OF WHY, not as current behaviour.
 * Historical:
 *
 * `LogEntry` has no `version` column and this route reads no `If-Match`. That
 * is deliberate: the offline outbox carries journal CREATEs (POST) and photo
 * uploads only — the modal's edit branch calls `apiPatch` DIRECTLY, so journal
 * edits never queue offline and there is no replay-staleness vector for them.
 * The outbox's 409 conflict flow (`OfflineConflictBanner`, keep-mine /
 * take-server) could therefore never engage for a journal edit even if a
 * version column existed.
 *
 * The one entity that does carry optimistic locking, `OperationParcel`, earned
 * it with a documented two-role workflow (a supervisor/reviewer changing a
 * line under the operator). Journal entries have no such second actor and no
 * co-editing feature.
 *
 * Revisit when either becomes true: journal edits start going through the
 * outbox, or a genuine concurrent-editor workflow appears. Then follow the
 * OperationParcel precedent end-to-end — `version Int`, `If-Match` here,
 * `updateMany` guarded on version, `staleData()` 409, and `ifMatch` on the
 * outbox item.
 */
export const PUT = withApiErrorHandling(withValidatedBody(UpdateLogEntrySchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'JOURNAL');
    // #919 — offline edits. The outbox replays a queued edit with the row
    // version the operator saw as `If-Match` and its item id as
    // `Idempotency-Key`. Both were already being SENT and neither was read,
    // which is why queueing edits was UNSAFE rather than merely absent:
    // without the version a replay clobbers a supervisor's later change, and
    // without the key the operator's own replay reads as a conflict with
    // themselves.
    //
    // Absent headers = an online edit from the modal, which keeps
    // last-write-wins exactly as before.
    const rawIfMatch = req.headers.get('If-Match');
    const expectedVersion = rawIfMatch !== null && /^\d+$/.test(rawIfMatch)
        ? Number.parseInt(rawIfMatch, 10)
        : undefined;
    const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
    const entry = await updateLogEntry(ctx, params.id, body, expectedVersion, idempotencyKey);
    return jsonResponse({ success: true, entry });
}));

export const PATCH = PUT;

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'JOURNAL');
    await deleteLogEntry(ctx, params.id);
    return jsonResponse({ success: true });
});
