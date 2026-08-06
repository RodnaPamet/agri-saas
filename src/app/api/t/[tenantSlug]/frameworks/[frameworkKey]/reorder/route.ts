/**
 * Epic 46.4 — Framework reorder endpoint.
 *
 * POST /api/t/[tenantSlug]/frameworks/[frameworkKey]/reorder
 *
 * Body: `{ sections: [{ sectionId, requirementIds: string[] }, ...] }`
 *
 * Persists a per-tenant `sortOrder` overlay for every
 * non-deprecated requirement in the framework. Admin-gated via
 * `assertCanInstallFrameworkPack` inside the usecase (the same
 * OWNER/ADMIN bar every other framework-write surface uses today).
 *
 * Why a path-level new route instead of an `?action=reorder` on
 * the existing handler: matches the `/tree` sibling route's
 * shape, keeps Zod validation isolated, and gives the
 * permission-coverage guardrail a single file to point at if the
 * frameworks subtree ever moves into the privileged-roots list.
 */

import { z } from 'zod';
import { reorderFrameworkRequirements } from '@/app-layer/usecases/framework';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

const ReorderSchema = z
    .object({
        sections: z
            .array(
                z.object({
                    sectionId: z.string().min(1),
                    requirementIds: z.array(z.string().min(1)),
                }),
            )
            .min(1)
            .max(500),
    })
    .strip();

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; frameworkKey: string }>(
        'admin.manage',
        async (req, { params }, ctx) => {
        const raw = await req.json();
        const body = ReorderSchema.parse(raw);
        const result = await reorderFrameworkRequirements(
            ctx,
            params.frameworkKey,
            body.sections,
        );
        return jsonResponse(result, { status: 200 });
        },
    ),
);
