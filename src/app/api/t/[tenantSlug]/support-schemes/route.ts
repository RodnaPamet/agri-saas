import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { listSupportSchemes } from '@/app-layer/usecases/support-schemes';
import {
    SUPPORT_SCHEME_AUTHORITIES,
    SUPPORT_SCHEME_STATUSES,
} from '@/app-layer/schemas/support-scheme.schemas';

const QuerySchema = z
    .object({
        authority: z.enum(SUPPORT_SCHEME_AUTHORITIES).optional(),
        status: z.enum(SUPPORT_SCHEME_STATUSES).optional(),
    })
    .strip();

/**
 * Government support schemes a farm can apply for — APPROVED rows only.
 *
 * GET-only and read-open to every role: a national ДФЗ measure is public
 * reference data, not one farm's business, the same reasoning `AgriEvent` and
 * the news feed already use. `getTenantCtx` still runs, so tenant membership
 * is enforced and the route is not anonymous.
 *
 * There is no tenant-facing WRITE surface at all. Curation is platform work
 * (`/api/admin/support-schemes`), because a subsidy measure is a national fact
 * and one farm editing it would change what every other farm reads.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        await getTenantCtx(params, req);

        const query = QuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        return jsonResponse(await listSupportSchemes(query));
    },
);
