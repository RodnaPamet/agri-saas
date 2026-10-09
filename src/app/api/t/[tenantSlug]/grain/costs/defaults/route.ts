import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getCostDefaults } from '@/app-layer/usecases/cost-defaults';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/[tenantSlug]/grain/costs/defaults
 *
 * What the farm last entered for each overhead, so «Нов разход» opens prefilled
 * instead of empty. The owner's decision was explicit that these are the farm's
 * OWN last values and that there is no Agrent-wide table — so a farm with no
 * history gets an empty array, never somebody else's numbers.
 *
 * ## No `commodity` parameter yet, and that is deliberate
 *
 * agrent-ios' proposal had `?commodity=…` for the per-crop half. It is absent
 * because the read path for it does not exist: `CostEntry` has no commodity
 * column, and all four live cost entries on the owner's farm carry NO domain
 * link at all — `parcelId`, `seasonId`, `plantingId`, `locationId`, `itemId`
 * and `leaseId` are each set on zero of them (measured by agrent-ios on
 * production, read-only counts).
 *
 * So `CostEntry.parcelId → Parcel.cropType` resolves nothing, and shipping the
 * parameter would add a filter that always returns empty. It also would have
 * prejudged #1512: per-crop «last values» can only come from entries the new
 * form creates, which will carry whatever crop target that issue settles on, so
 * the read must key on that field rather than on a path chosen first.
 *
 * Adding the parameter later is additive — a client that does not send it keeps
 * the behaviour it has.
 *
 * ## Gated and cached like its siblings
 *
 * `assertModuleEnabled(ctx, 'GRAIN')` matches the cost register this prefills;
 * a farm that cannot see costs has no use for their defaults.
 *
 * `jsonWithETag` with the family's default `private, no-cache` — store but
 * always revalidate. Not a longer window: this changes the moment the farmer
 * saves a cost, and a prefill showing a figure they have just superseded is
 * worse than a round trip. The 304 keeps the revalidation cheap.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');
        return jsonWithETag(req, await getCostDefaults(ctx));
    },
);
