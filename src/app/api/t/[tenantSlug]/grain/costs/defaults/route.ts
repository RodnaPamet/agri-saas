import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getCostDefaults, getCropCostDefaults } from '@/app-layer/usecases/cost-defaults';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * GET /api/t/[tenantSlug]/grain/costs/defaults?commodity=
 *
 * What the farm last entered for each overhead, so «Нов разход» opens prefilled
 * instead of empty. The owner's decision was explicit that these are the farm's
 * OWN last values and that there is no Agrent-wide table — so a farm with no
 * history gets an empty array, never somebody else's numbers.
 *
 * ## `?commodity=` — the per-crop half, added by agrent-ios#245
 *
 * This docblock used to explain at length why the parameter was ABSENT, and
 * the explanation was right at the time: `CostEntry` had no commodity column,
 * and all four live cost entries on the owner's farm carry no domain link at
 * all — `parcelId`, `seasonId`, `plantingId`, `locationId`, `itemId` and
 * `leaseId` each set on zero of them (measured by agrent-ios on production,
 * read-only counts). So `CostEntry.parcelId → Parcel.cropType` resolved
 * nothing and the parameter would have been a filter that always returned
 * empty.
 *
 * #1583 added `commodityCanonical`, so the read now has a key that the crop
 * form actually populates — and the old reasoning's own conclusion was that
 * the read "must key on that field rather than on a path chosen first", which
 * is what `getCropCostDefaults` does.
 *
 * It is additive, as that note predicted: a client that sends no `commodity`
 * gets exactly the overhead payload it got before.
 *
 * An UNRESOLVABLE commodity is refused rather than answered with an empty
 * sheet — an empty answer would be indistinguishable from "this crop has no
 * history", so a typo would read as a fact about the farm.
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
