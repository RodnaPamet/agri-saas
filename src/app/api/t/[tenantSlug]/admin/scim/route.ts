/**
 * SCIM Token Management API
 *
 * GET    /api/t/[tenantSlug]/admin/scim — list SCIM tokens (masked)
 * POST   /api/t/[tenantSlug]/admin/scim — generate new token (returns plaintext ONCE)
 * DELETE /api/t/[tenantSlug]/admin/scim — revoke a token
 *
 * Admin-only. Tokens are stored as SHA-256 hashes. The plaintext is only
 * returned on creation and cannot be retrieved afterward.
 */
import { NextRequest } from 'next/server';
import { randomBytes, createHash } from 'crypto';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import prisma from '@/lib/prisma';
import { jsonResponse } from '@/lib/api-response';
import { assertScimEnabled } from '@/lib/auth/tenant-sso-availability';

/**
 * GET — list SCIM tokens for tenant (admin.scim only).
 * Returns token metadata only (never the actual token value).
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.scim', async (req: NextRequest, _routeArgs, ctx) => {
    await assertScimEnabled();
        const tokens = await prisma.tenantScimToken.findMany({
            where: { tenantId: ctx.tenantId },
            select: {
                id: true,
                label: true,
                lastUsedAt: true,
                revokedAt: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        // Also return the SCIM endpoint base URL for admin visibility
        const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

        return jsonResponse({
            tokens,
            scimEndpoint: `${baseUrl}/api/scim/v2`,
            isEnabled: tokens.some((t) => !t.revokedAt),
        });
    }),
);

/**
 * POST — generate a new SCIM bearer token (admin.scim only).
 * Returns the plaintext token ONCE. It is stored as a SHA-256 hash.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.scim', async (req: NextRequest, _routeArgs, ctx) => {
    await assertScimEnabled();
        const body = (await req.json()) as { label?: string };
        const label = body.label || 'SCIM Token';

        // Generate a cryptographically secure token
        const plaintext = `scim_${randomBytes(32).toString('base64url')}`;
        const tokenHash = createHash('sha256').update(plaintext).digest('hex');

        const token = await prisma.tenantScimToken.create({
            data: {
                tenantId: ctx.tenantId,
                label,
                tokenHash,
            },
            select: { id: true, label: true, createdAt: true },
        });

        // Return the plaintext token ONCE — it cannot be retrieved again
        return jsonResponse(
            {
                ...token,
                plaintext,
                warning: 'Copy this token now. It will not be shown again.',
            },
            { status: 201 },
        );
    }),
);

/**
 * DELETE — revoke a SCIM token (admin.scim only).
 */
export const DELETE = withApiErrorHandling(
    requirePermission('admin.scim', async (req: NextRequest, _routeArgs, ctx) => {
    await assertScimEnabled();
        const { tokenId } = (await req.json()) as { tokenId: string };
        if (!tokenId) {
            return jsonResponse({ error: 'tokenId required' }, { status: 400 });
        }

        // Verify token belongs to this tenant
        const existing = await prisma.tenantScimToken.findFirst({
            where: { id: tokenId, tenantId: ctx.tenantId },
        });

        if (!existing) {
            return jsonResponse({ error: 'Token not found' }, { status: 404 });
        }

        await prisma.tenantScimToken.update({
            where: { id: tokenId },
            data: { revokedAt: new Date() },
        });

        return jsonResponse({ ok: true, revokedAt: new Date().toISOString() });
    }),
);
