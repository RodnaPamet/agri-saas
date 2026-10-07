/**
 * `GET /api/admin/farm-claims` — the staff review queue (P3.9).
 *
 * Platform-admin, not a tenant role: review is inherently cross-tenant (the
 * collision case is two different farms claiming one ЕИК), and a tenant ADMIN
 * being able to approve their own farm's identity would make the whole
 * mechanism self-service. Same `X-Platform-Admin-Key` gate as
 * `/api/admin/tenants` and `/api/admin/feature-flags`.
 *
 * ── there is no ЕИК in the response, and that is the design ──
 *
 * Not the plaintext, which `FarmIdentityClaim` never holds, and not the hash
 * either. The hash is not reversible but it IS a stable per-identity token, so
 * putting it on a console screen would let anyone who can read a screenshot
 * correlate two farms' claims — which is most of what the blind index exists
 * to prevent.
 *
 * The reviewer does not need it. They read the farm's NAME off this queue,
 * look that name up in the Търговски регистър themselves, and supply the
 * number they find to the verify endpoint. See `farm-identity-review.ts` for
 * why that is stronger than disclosure rather than a workaround for it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { listFarmClaims } from '@/app-layer/usecases/farm-identity-review';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';
import { parseLimitParam } from '@/lib/validation/query-params';

export const runtime = 'nodejs';

const Query = z.object({
    status: z.enum(['PENDING', 'VERIFIED', 'DISPUTED']).optional(),
    before: z.coerce.date().optional(),
});

/** Convert the verifier's typed failure into its HTTP answer. */
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

export const GET = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const parsed = Query.safeParse({
            status: req.nextUrl.searchParams.get('status') ?? undefined,
            before: req.nextUrl.searchParams.get('before') ?? undefined,
        });
        if (!parsed.success) {
            return jsonResponse({ error: 'invalid_request' }, { status: 400 });
        }

        // `limit` goes through the shared `parseLimitParam`, not a local zod
        // coercion. `tests/guards/limit-param-nan-safe.test.ts` requires it on
        // every route reading the param, and its reason generalises: `??` does
        // not catch NaN and Math.min/max propagate it, so `take: NaN` reaches
        // Prisma and the route 500s on `?limit=abc`. One parser also means one
        // error shape for a malformed limit across 30-odd routes.
        // No `label`: `parseLimitParam` already defaults it to 'limit', so
        // passing it was redundant — and `no-hardcoded-ui-strings` counts a
        // `label:` property as user-facing copy, which it would be if it were
        // anything other than the parameter's own name.
        const limit = parseLimitParam(req.nextUrl.searchParams.get('limit'), { max: 200 });

        return jsonResponse({ claims: await listFarmClaims({ ...parsed.data, limit }) });
    },
    {
        // Same pre-auth tier as the other platform-admin surfaces: the header
        // IS the credential, so this sits in the same abuse position as sign-in.
        rateLimit: { config: LOGIN_LIMIT, scope: 'platform-farm-claims' },
    },
);
