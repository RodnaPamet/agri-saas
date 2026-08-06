import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { assertModuleEnabled } from '@/app-layer/usecases/modules';
import { listSchemes, createScheme } from '@/app-layer/usecases/certification-scheme';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * Certification schemes — global AG_SCHEME frameworks surfaced per
 * tenant. Gated behind the CERTIFICATION module (the API twin of the
 * `/schemes` route-group `requireModule` redirect). The create path is
 * platform-gated — see the POST docblock.
 */

// Inline body schema (kept in-file so structural guardrails see it).
const CreateSchemeSchema = z
    .object({
        key: z
            .string()
            .min(1)
            .max(120)
            // Stable, URL-/code-safe scheme key.
            .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Key must be alphanumeric with . _ -'),
        name: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        requirements: z
            .array(
                z.object({
                    code: z.string().min(1).max(60),
                    title: z.string().min(1).max(300),
                    description: z.string().max(2000).optional(),
                }),
            )
            .min(1, 'At least one requirement required')
            .max(500),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        await assertModuleEnabled(ctx, 'CERTIFICATION');
        const schemes = await listSchemes(ctx);
        return jsonResponse(schemes);
    },
);

/**
 * Authoring a scheme writes the GLOBAL catalogue every tenant reads, so this
 * is a PLATFORM operation. Two gates, both load-bearing:
 *
 *   - `requirePermission('admin.manage')` — necessary, NOT sufficient.
 *     Permissions resolve from Role, so every farm's OWNER/ADMIN holds it. Its
 *     job is to make a denial an audited AUTHZ_DENIED row and to keep this
 *     route inside the Epic C.1 coverage guardrail.
 *   - `assertCanWriteCatalogue(ctx)` inside `createScheme` — the actual
 *     isolation control. It 404s outside the designated platform tenant.
 *
 * Farms adopt standards from the catalogue (see the scheme detail page); they
 * do not author them.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req, _routeArgs, ctx) => {
        await assertModuleEnabled(ctx, 'CERTIFICATION');
        const body = CreateSchemeSchema.parse(await req.json());
        const scheme = await createScheme(ctx, body);
        return jsonResponse(scheme, { status: 201 });
    }),
);
