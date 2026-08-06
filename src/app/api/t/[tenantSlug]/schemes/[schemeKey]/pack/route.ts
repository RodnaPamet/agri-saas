import { z } from 'zod';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { assembleSchemePack } from '@/app-layer/usecases/scheme-pack';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Assemble a scheme inspection pack — a FROZEN-able, SHARE-able audit pack
 * scoped to one certification scheme (a global AG_SCHEME framework). Gated
 * behind the CERTIFICATION module. Admin gate (OWNER/ADMIN/EDITOR) lives
 * inside `assembleSchemePack`.
 *
 * The caller FREEZES + SHARES the returned pack via the EXISTING audit-pack
 * freeze + share endpoints — this route only builds the DRAFT pack.
 */

const AssembleSchemePackSchema = z
    .object({
        auditCycleId: z.string().min(1),
        name: z.string().min(1).max(200),
    })
    .strip();

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; schemeKey: string }>(
        'audits.manage',
        async (req, { params }, ctx) => {
            const body = AssembleSchemePackSchema.parse(await req.json());
            await assertModuleEnabled(ctx, 'CERTIFICATION');
            const result = await assembleSchemePack(ctx, {
                schemeKey: params.schemeKey,
                auditCycleId: body.auditCycleId,
                name: body.name,
            });
            return jsonResponse(result, { status: 201 });
        },
    ),
);
