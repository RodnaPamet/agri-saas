import { NextRequest } from 'next/server';
import { getLegacyCtx } from '@/app-layer/context';
import {
    getTenantSsoConfig,
    upsertTenantSsoConfig,
    deleteTenantSsoConfig,
    toggleTenantSso,
    setTenantSsoEnforced,
} from '@/app-layer/usecases/sso';
import { UpsertSsoConfigInput } from '@/app-layer/schemas/sso-config.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertTenantSsoEnabled } from '@/lib/auth/tenant-sso-availability';

/**
 * GET /api/sso — list all SSO providers for the tenant (ADMIN only)
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    await assertTenantSsoEnabled();
    const ctx = await getLegacyCtx(req);
    const providers = await getTenantSsoConfig(ctx);
    // Strip secrets from configJson before sending to client
    const safe = providers.map((p) => ({
        ...p,
        configJson: maskSecrets(p.configJson as Record<string, unknown>),
    }));
    return jsonResponse(safe);
});

/**
 * POST /api/sso — create or update an SSO provider (ADMIN only)
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
    await assertTenantSsoEnabled();
    const ctx = await getLegacyCtx(req);
    const body = await req.json();
    const parsed = UpsertSsoConfigInput.parse(body);
    const provider = await upsertTenantSsoConfig(ctx, parsed);
    return jsonResponse(provider, { status: body.id ? 200 : 201 });
});

/**
 * PATCH /api/sso — toggle enable/enforce flags (ADMIN only)
 * Body: { id: string, action: 'enable' | 'disable' | 'enforce' | 'unenforce' }
 */
export const PATCH = withApiErrorHandling(async (req: NextRequest) => {
    await assertTenantSsoEnabled();
    const ctx = await getLegacyCtx(req);
    const { id, action } = await req.json() as { id: string; action: string };

    let result;
    switch (action) {
        case 'enable':
            result = await toggleTenantSso(ctx, id, true);
            break;
        case 'disable':
            result = await toggleTenantSso(ctx, id, false);
            break;
        case 'enforce':
            result = await setTenantSsoEnforced(ctx, id, true);
            break;
        case 'unenforce':
            result = await setTenantSsoEnforced(ctx, id, false);
            break;
        default:
            return jsonResponse({ error: 'Invalid action' }, { status: 400 });
    }
    return jsonResponse(result);
});

/**
 * DELETE /api/sso — delete an SSO provider (ADMIN only)
 * Body: { id: string }
 */
export const DELETE = withApiErrorHandling(async (req: NextRequest) => {
    await assertTenantSsoEnabled();
    const ctx = await getLegacyCtx(req);
    const { id } = await req.json() as { id: string };
    await deleteTenantSsoConfig(ctx, id);
    return jsonResponse({ ok: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Mask sensitive fields in configJson before sending to the client.
 * Secrets are replaced with '••••••••' to indicate they are set.
 */
function maskSecrets(config: Record<string, unknown>): Record<string, unknown> {
    const masked = { ...config };
    const secretKeys = ['clientSecret', 'certificate', 'privateKey'];
    for (const key of secretKeys) {
        if (masked[key] && typeof masked[key] === 'string') {
            masked[key] = '••••••••';
        }
    }
    return masked;
}
