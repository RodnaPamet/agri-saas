import { NextRequest } from 'next/server';
import { gone } from '@/lib/errors/types';
import {
    API_KEY_AUTH_ENABLED,
    API_KEY_DISABLED_MESSAGE,
} from '@/lib/auth/api-key-availability';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listApiKeys, createApiKey } from '@/app-layer/usecases/api-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const CreateApiKeySchema = z.object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.string()).min(1),
    expiresAt: z.string().nullable().optional(),
});

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        const keys = await listApiKeys(ctx);
        return jsonResponse(keys);
    }),
);

// API key minting is the canonical post-compromise amplification surface:
// a stolen session can create persistent machine credentials. Override
// the default API_MUTATION_LIMIT with the tight API_KEY_CREATE_LIMIT
// (5/hr, 1hr lockout) and a dedicated scope so the budget never
// competes with ordinary mutation traffic.
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        // Minting is closed. A key created here could never authenticate a
        // request — the Edge refuses an `iflk_` bearer before any handler runs
        // — so handing an operator one, with "copy it now, it will never be
        // shown again", costs them a support cycle to discover it was never
        // going to work. 410 rather than 404: the endpoint EXISTED and the
        // body says why, because an opaque refusal is the same failure again.
        if (!API_KEY_AUTH_ENABLED) throw gone(API_KEY_DISABLED_MESSAGE);
        const body = await req.json();
        const input = CreateApiKeySchema.parse(body);
        const result = await createApiKey(ctx, input);
        return jsonResponse(result, { status: 201 });
    }),
    {
        rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'api-key-create' },
    },
);
