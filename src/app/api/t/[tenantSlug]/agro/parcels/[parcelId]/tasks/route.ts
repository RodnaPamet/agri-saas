import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listTasksForParcel } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/{slug}/agro/parcels/{parcelId}/tasks
 *
 * Every task that touches this parcel, newest first — what «Блокове» → a
 * parcel shows beneath its risk (#2463, contract agreed with agrent-ios).
 *
 * ## Why this exists when `GET /tasks` already filters by linked entity
 *
 * `GET /tasks?linkedEntityType=PARCEL&linkedEntityId=…` answers with the
 * scouting and hand-made tasks and **silently omits every planned spray and
 * fertilising**. A field operation reaches its parcels through its operation
 * LINES, not through a `PARCEL` task link — see `taskParcelIds`, which unions
 * both sources in the other direction and whose docblock says why a type
 * filter would be wrong. So the existing filter returns a confident, partial
 * answer: the majority of what was done to the field, missing, with nothing
 * indicating anything was left out.
 *
 * ## Sited under `agro/parcels/{parcelId}/`, beside what the screen already calls
 *
 * The parcel-scoped family lives here — `analysis` (the risk this screen shows
 * above the tasks), `history` (the screen itself), `crop-seasons`,
 * `weed-observations`. A second parcel-scoped prefix would put siblings of one
 * screen under two trees.
 *
 * ## Why the id is a path segment and there is no query string at all
 *
 * Same reason as `analysis` and `history`: iOS writes the full request URL
 * including the query to the unified log, below any logging the app controls.
 * An id in a query string is an id in a device-local log. There is also simply
 * nothing to parameterise — the cap is a constant, every status is returned,
 * and the order is fixed — so a query parameter would be a surface to validate
 * for no gain.
 *
 * ## No gates here
 *
 * `assertCanReadTasks` and the parcel's own 404 are in the usecase, which is
 * also what any second caller would reach. A gate in two places is a gate that
 * can disagree with itself.
 *
 * ETag'd per the convention for cacheable list GETs. Safe despite the
 * per-caller `mayDelete`: the tag is computed over THIS response body, so two
 * callers whose flags differ get different bodies and therefore different
 * tags — there is no shared entry for one caller's permissions to leak into.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; parcelId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonWithETag(req, await listTasksForParcel(ctx, params.parcelId));
    },
);
