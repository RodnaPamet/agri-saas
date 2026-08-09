import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listLogEntries, listLogEntriesPaginated, listDeletedLogEntries, createLogEntry } from '@/app-layer/usecases/journal';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateLogEntrySchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { jsonWithETag } from '@/lib/http/etag';

const JournalQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    occurredFrom: z.string().optional(),
    occurredTo: z.string().optional(),
    // Trash view — soft-deleted entries only (ADMIN).
    deleted: z.enum(['true', 'false']).optional(),
    // dnevnik filters (#10)
    crop: z.string().optional(),
    locationId: z.string().optional(),
    // Scope to a crop plan's plantings (plan-detail Journal tab).
    cropPlanId: z.string().optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'JOURNAL');
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = JournalQuerySchema.parse(sp);

    if (query.deleted === 'true') {
        return jsonResponse({ entries: await listDeletedLogEntries(ctx) });
    }

    const filters = {
        type: query.type,
        status: query.status,
        q: query.q,
        occurredFrom: query.occurredFrom,
        occurredTo: query.occurredTo,
        crop: query.crop,
        locationId: query.locationId,
        cropPlanId: query.cropPlanId,
    };

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listLogEntriesPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters,
        });
        // Roadmap-6 P3 — emit the `{ rows, nextCursor }` shape the
        // client `useCursorPagination` accumulator consumes directly.
        // The bounded page (limit ≤ 100, default 20) replaces the flat
        // take:200 cold-start payload; ETag/304 makes revalidation cheap
        // on rural LTE.
        return jsonWithETag(req, {
            rows: result.items,
            nextCursor: result.pageInfo.nextCursor ?? null,
        });
    }

    // Backward-compat: a flat array (vs the paginated branch's
    // `{ rows, nextCursor }`).
    //
    // The old comment credited "the offline outbox" — that is impossible:
    // `OutboxMethod` is POST | PATCH | DELETE, so the outbox never GETs
    // anything. And the two usecase consumers people reach for
    // (`ag-dashboard`, `satellite-briefing`) import `listLogEntries`
    // DIRECTLY — they never traverse this route, so they don't depend on
    // this shape either.
    //
    // The only real consumer of the flat shape is the e2e verification GET
    // in `journal-offline-create.spec.ts`, which casts the body to an array.
    // The browser client always sends `limit`, so it takes the paginated
    // branch. Naming this correctly so a future cleanup deletes the right
    // branch — or knowingly updates that spec.
    const entries = await listLogEntries(ctx, filters);
    return jsonWithETag(req, entries);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateLogEntrySchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await assertModuleEnabled(ctx, 'JOURNAL');
    // Offline exactly-once — the outbox replays a queued journal entry with its
    // item id as the Idempotency-Key; the usecase dedupes on it so a re-send
    // over flaky rural LTE returns the original entry, not a duplicate.
    const idempotencyKey = req.headers.get('Idempotency-Key') || undefined;
    const entry = await createLogEntry(ctx, body, idempotencyKey);
    return jsonResponse(entry, { status: 201 });
}));
