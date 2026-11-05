import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { listActivePromotions } from '@/app-layer/usecases/promotions';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * «Оферти» — the supplier promotions feed a farm can see (#2725).
 *
 * `GET /api/t/{tenantSlug}/offers -> { offers: PromotionDto[] }`
 *
 * Owner directive 2026-11-02: put «Оферти» on the phone. The web page has
 * rendered this feed since #12 — as a SERVER COMPONENT calling
 * `listActivePromotions(ctx)` directly — so there was no endpoint for a native
 * client to call at all. The lead POST (`offers/leads`) and the image byte
 * route (`/api/promotions/{id}/image`) already existed; only the list was
 * missing.
 *
 * ## An ENVELOPE, not a bare array
 *
 * `{ offers }` on agrent-ios' ask, and their reason is the right one: a later
 * `nextCursor` or a feed-level note then does not break a decode that is
 * already shipped on devices. The exchange listings read is the cautionary
 * sibling — `/journal` still serves a bare array for clients that predate its
 * cursor branch, and CLAUDE.md records that nobody can retire it because
 * nobody can prove what calls it.
 *
 * ## Tenant-scoped path, GLOBAL catalogue
 *
 * `Promotion` has no `tenantId` — it is one cross-tenant catalogue — but this
 * sits under `/api/t/{tenantSlug}/` because the CALLER is a farm member, and
 * that is the segment the Edge read tier already covers (`API_READ_LIMIT`,
 * keyed `(IP, userId, tenantSlug)`). At `/api/offers` it would be exempt from
 * that tier for no gain. `hasRequested` is viewer-relative too, so the tenant
 * is load-bearing for the payload and not only for the gate.
 *
 * ## `assertCanRead`, deliberately NOT the lead route's gate
 *
 * `listActivePromotions` calls `assertCanRead`, so a READER sees the feed.
 * Sending a lead calls `assertCanWrite` and refuses them — owner ruling
 * 2026-11-02, asked as an explicit choice: owners, admins and members ask
 * suppliers on the farm's behalf, a Читател sees offers but does not ask. The
 * two routes sit at different permission levels ON PURPOSE; giving them the
 * same gate in either direction undoes a product decision.
 *
 * ## No ПРЗ withholding here
 *
 * Owner ruling 2026-11-02: the Reg. (EC) 1107/2009 Art 66 withholding
 * predicate (#2664, #2665) covers the ASSISTANT only, for now. This feed
 * returns everything published, exactly as the web page does.
 *
 * ## ETag
 *
 * `jsonWithETag` because this read is on `PERSISTABLE_PATHS`: a phone keeps it
 * across launches and revalidates on open, and without an ETag that
 * revalidation is a FULL body rather than a 304. Same argument as `/items`
 * (#1845) and CLAUDE.md's rule for a cacheable list GET.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const offers = await listActivePromotions(ctx);
        return jsonWithETag(req, { offers });
    },
);
