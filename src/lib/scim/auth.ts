/**
 * SCIM 2.0 Authentication Middleware
 *
 * Authenticates SCIM requests using tenant-scoped bearer tokens.
 * The token is hashed (SHA-256) and looked up in TenantScimToken.
 * The tenant is resolved from the token, NOT from the caller.
 *
 * Usage:
 *   const scimCtx = await authenticateScimRequest(req);
 *   // scimCtx.tenantId is the tenant that owns the token
 */
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { recordScimAuth } from '@/lib/observability/metrics';
import { isScimEnabled } from '@/lib/auth/tenant-sso-availability';

export interface ScimContext {
    tenantId: string;
    tokenId: string;
    tokenLabel: string;
}

export class ScimAuthError extends Error {
    public readonly status: number;
    public readonly scimType: string;

    constructor(message: string, status = 401, scimType = 'invalidToken') {
        super(message);
        this.name = 'ScimAuthError';
        this.status = status;
        this.scimType = scimType;
    }
}

/**
 * Hash a bearer token with SHA-256 for lookup.
 */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

/**
 * Authenticate a SCIM request by extracting and validating the bearer token.
 * Returns a ScimContext with the resolved tenantId.
 *
 * Throws ScimAuthError if:
 * - SCIM is turned off (404 — see `@/lib/auth/tenant-sso-availability`)
 * - No Authorization header
 * - Token not found or revoked
 */
export async function authenticateScimRequest(req: NextRequest): Promise<ScimContext> {
    // Every SCIM resource route authenticates through here, so this is the
    // one place the off switch has to sit. Checked BEFORE the token, so a
    // dormant SCIM surface answers the same 404 to a valid token, a revoked
    // one and none — it does not confirm that any token is still live.
    if (!(await isScimEnabled())) {
        throw new ScimAuthError('Not found', 404, '');
    }
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        recordScimAuth({ outcome: 'failure', reason: 'missing_header' });
        throw new ScimAuthError('Missing or invalid Authorization header', 401);
    }

    const rawToken = authHeader.slice('Bearer '.length).trim();
    if (!rawToken) {
        recordScimAuth({ outcome: 'failure', reason: 'empty_token' });
        throw new ScimAuthError('Empty bearer token', 401);
    }

    const tokenHash = hashToken(rawToken);

    const scimToken = await prisma.tenantScimToken.findUnique({
        where: { tokenHash },
        include: { tenant: { select: { id: true, slug: true } } },
    });

    if (!scimToken) {
        recordScimAuth({ outcome: 'failure', reason: 'not_found' });
        logger.warn('SCIM auth failed: token not found', { component: 'scim' });
        throw new ScimAuthError('Invalid SCIM token', 401);
    }

    if (scimToken.revokedAt) {
        recordScimAuth({ outcome: 'failure', reason: 'revoked' });
        logger.warn('SCIM auth failed: token revoked', { component: 'scim', tokenId: scimToken.id });
        throw new ScimAuthError('SCIM token has been revoked', 401);
    }

    // Update lastUsedAt (fire-and-forget, don't block the request)
    prisma.tenantScimToken.update({
        where: { id: scimToken.id },
        data: { lastUsedAt: new Date() },
    }).catch(() => { /* swallow — non-critical */ });

    recordScimAuth({ outcome: 'success', reason: 'ok' });
    logger.info('SCIM request authenticated', {
        component: 'scim',
        tenantId: scimToken.tenantId,
        tokenId: scimToken.id,
        tokenLabel: scimToken.label,
    });

    return {
        tenantId: scimToken.tenantId,
        tokenId: scimToken.id,
        tokenLabel: scimToken.label,
    };
}
