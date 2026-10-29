import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listParcelComments } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/{slug}/agro/parcels/{parcelId}/comments
 *
 * A parcel's comments and closing notes, newest first — the history half of a
 * MECHANISATOR's one screen (#2474, contract agreed with agrent-ios).
 *
 * ## One read per parcel, which is the whole point
 *
 * The alternative is `GET /tasks/{id}/comments` per task on the parcel. A
 * sprayer opening a field with a season of work on it would make dozens of
 * requests on rural LTE, which is what this replaces.
 *
 * ## Why a route of its own rather than fields on the parcel-tasks response
 *
 * Folding comment bodies onto `/agro/parcels/{parcelId}/tasks` would make that
 * response N tasks x M comments against a page already capped at 200 rows. The
 * other option was a comment COUNT on those rows plus a per-task thread read,
 * which is two reads per parcel the moment the operator reads anything — the
 * opposite of the ask. Owner chose this shape (2026-10-29).
 *
 * ## Reachable by the persona it is for, without a middleware change
 *
 * `isOperatorAllowedPath` admits everything under `agro/`, so a MECHANISATOR
 * can call this. Worth stating because a route sited anywhere else would 403
 * for exactly the role it was built for, with nothing in the route saying why
 * — the same seam that has caught this repo eight times.
 *
 * ## No gates here
 *
 * `assertCanReadTasks` and the parcel's own 404 are in the usecase, which any
 * second caller would also reach. A gate in two places is a gate that can
 * disagree with itself.
 *
 * ETag'd per the convention for cacheable list GETs. The response carries no
 * per-caller field, so unlike the parcel-tasks route there is not even a
 * shared-entry question to reason about.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonWithETag(req, await listParcelComments(ctx, params.parcelId));
    },
);
