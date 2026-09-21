import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { getGrainNetWorth } from '@/app-layer/usecases/grain-net-worth';
import { buildCalculatorPayload } from '@/lib/grain/calculator-payload';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonWithETag } from '@/lib/http/etag';

/**
 * Grain net-worth calculator — the API twin of `/grain/calculator` (GRAIN).
 *
 *   GET → the whole calculator payload: per-commodity rows, the farm-level
 *         totals, exclusions, cash-out, and the two figures that sit BESIDE
 *         the cost side (`unallocatedToCrop`, `imputedLandCharge`).
 *
 * ── Why this exists ──
 *
 * The page is a Server Component that calls the usecase directly and hands
 * the result to a client island — `force-dynamic` plus a server read IS the
 * data path, and there was no route at all. A native client cannot consume a
 * Server Component, so the same answer needs an HTTP door.
 *
 * It serves `buildCalculatorPayload`, the SAME mapper the page uses, rather
 * than a mapping of its own. Two spellings of one payload drift apart, and
 * this project has already paid for that lesson.
 *
 * ── Two ways this route is NOT its page ──
 *
 *   1. **It gates the module itself.** `grain/layout.tsx` runs
 *      `requireModule(ctx, 'GRAIN')` for every page beneath it, and the page
 *      deliberately does not repeat the check. An API route has NO layout
 *      above it, so skipping the gate here would serve GRAIN data to a tenant
 *      whose plan or settings exclude the module. Every sibling grain route
 *      calls `assertModuleEnabled` for this reason.
 *   2. **It carries an ETag.** The page re-renders per request; a client
 *      polling this one should get a cheap 304 instead of a full payload.
 *
 * Auth is `getTenantCtx`, which reaches `auth()` and therefore the native
 * bearer fallback. Importing `getServerSession` directly would authenticate a
 * browser and 401 the phone — `tests/guards/native-bearer-auth-parity.test.ts`
 * fails any route that does. Read/write permission is asserted inside the
 * usecase, as every grain route does.
 */
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'GRAIN');

        return jsonWithETag(req, buildCalculatorPayload(await getGrainNetWorth(ctx)));
    },
);
