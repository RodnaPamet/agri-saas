import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getFarmProfile, upsertFarmProfile } from '@/app-layer/usecases/farm-profile';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { etagFor, parseIfMatch } from '@/lib/http/if-match';
import { UpdateFarmProfileSchema } from '@/app-layer/schemas/farm-profile.schemas';

// `If-Match` and the ETag it round-trips are parsed by ONE shared module
// (#1182). This route wrote the strict parser first, because `version 0` is a
// SENTINEL here meaning "no row exists yet" — so a malformed header coerced to
// 0 would become a CREATE attempt, which is why it never reused
// `field-operations`' parseInt. That parser is now `@/lib/http/if-match`, used
// by all three locked routes, so a fourth cannot pick a looser one.
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        const profile = await getFarmProfile(ctx);
        // `version` is in the body AND the ETag header. The body is what the
        // existing clients read; the header is what an HTTP client that already
        // speaks preconditions will reach for, and it round-trips verbatim
        // because the quoted form is accepted above.
        return jsonResponse(profile, { headers: { ETag: etagFor(profile.version) } });
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const expectedVersion = parseIfMatch(req.headers.get('If-Match'));
        const body = UpdateFarmProfileSchema.parse(await req.json());
        const profile = await upsertFarmProfile(ctx, body, expectedVersion);
        // The NEW tag, so a client need not re-GET before its next write.
        return jsonResponse(profile, { headers: { ETag: etagFor(profile.version) } });
    }),
);
