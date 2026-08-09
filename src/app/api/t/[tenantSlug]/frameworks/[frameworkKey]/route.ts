import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    getFramework,
    getFrameworkRequirements,
    listFrameworkPacks,
    computeRequirementsDiff,
    upsertRequirements,
} from '@/app-layer/usecases/framework';
import { listFarmRecordsBackingFramework } from '@/app-layer/usecases/farm-record-traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

/**
 * Framework requirement catalogue.
 *
 * The compliance uproot removed the control layer, so the coverage /
 * template / readiness / pack-install actions this route used to serve are
 * gone with it — a requirement is no longer "covered" by a Control row, and
 * there is no template library to install from. What remains is the
 * catalogue itself: read the requirements, diff two versions, see which farm
 * records back them, and upsert the global fixture.
 */

const UpsertRequirementsSchema = z
    .object({
        requirements: z
            .array(
                z.object({
                    code: z.string().min(1),
                    title: z.string().min(1),
                    description: z.string().optional(),
                    section: z.string().optional(),
                    category: z.string().optional(),
                    theme: z.string().optional(),
                    themeNumber: z.number().int().optional(),
                    sortOrder: z.number().int().optional(),
                }),
            )
            .min(1),
        deprecateMissing: z.boolean().optional(),
    })
    .strip();

// GET /api/t/[tenantSlug]/frameworks/[frameworkKey]?action=...
export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; frameworkKey: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const url = new URL(req.url);
        const version = url.searchParams.get('version') || undefined;
        const action = url.searchParams.get('action');

        if (action === 'requirements') {
            return jsonResponse(await getFrameworkRequirements(ctx, params.frameworkKey, version));
        }
        if (action === 'packs') {
            return jsonResponse(await listFrameworkPacks(ctx, params.frameworkKey, version));
        }
        if (action === 'diff') {
            const from = url.searchParams.get('from');
            if (!from) return jsonResponse({ error: 'from required' }, { status: 400 });
            return jsonResponse(await computeRequirementsDiff(ctx, from, params.frameworkKey));
        }
        if (action === 'farm-records') {
            // The reverse of auto-evidence: which journal entries back this
            // framework's requirements. `Evidence.sourceLogEntryId` and its
            // index were added for this query.
            return jsonResponse(await listFarmRecordsBackingFramework(ctx, params.frameworkKey));
        }

        return jsonResponse(await getFramework(ctx, params.frameworkKey, version));
    },
);

// POST /api/t/[tenantSlug]/frameworks/[frameworkKey]?action=upsert-requirements
//
// The only remaining write. It targets the GLOBAL catalogue and is gated
// inside the usecase by `assertCanWriteCatalogue` (the platform-tenant gate);
// `requirePermission('admin.manage')` wraps the handler so a denial emits an
// audited AUTHZ_DENIED row and the route stays inside the Epic C.1 coverage
// guardrail. It is the audited role floor, NOT the isolation control.
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; frameworkKey: string }>('admin.manage', async (req, { params }, ctx) => {
        const url = new URL(req.url);
        const action = url.searchParams.get('action');
        if (action !== 'upsert-requirements') {
            return jsonResponse({ error: 'Unknown action' }, { status: 400 });
        }
        const body = UpsertRequirementsSchema.parse(await req.json());
        return jsonResponse(
            await upsertRequirements(ctx, params.frameworkKey, body.requirements, {
                deprecateMissing: body.deprecateMissing,
            }),
            { status: 200 },
        );
    }),
);
