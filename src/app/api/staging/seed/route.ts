/**
 * POST /api/staging/seed
 *
 * Token-gated staging seed endpoint.
 * Only works when NODE_ENV !== 'production'.
 *
 * Requires header: x-seed-token: <STAGING_SEED_TOKEN env var>
 *
 * This endpoint is intentionally NOT in the tenant-scoped route tree.
 */
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';
import { hashForLookup } from '@/lib/security/encryption';

export async function POST(req: NextRequest) {
    // ── Gate 1: Environment check ──
    if (process.env.NODE_ENV === 'production') {
        return jsonResponse(
            { error: 'Seed endpoint is disabled in production' },
            { status: 403 }
        );
    }

    // ── Gate 2: Token check ──
    const seedToken = process.env.STAGING_SEED_TOKEN;
    if (!seedToken) {
        return jsonResponse(
            { error: 'STAGING_SEED_TOKEN env var not set' },
            { status: 503 }
        );
    }

    const providedToken = req.headers.get('x-seed-token');
    if (providedToken !== seedToken) {
        logger.warn('Unauthorized staging seed attempt', { component: 'staging-seed' });
        return jsonResponse(
            { error: 'Invalid seed token' },
            { status: 401 }
        );
    }

    // ── Gate 3: Execute seed ──
    logger.info('Staging seed triggered via API', { component: 'staging-seed' });
    // Prisma 7 — adapter is required for connection initialisation.
    const prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
    });

    try {
        // Run the base seed inline (simplified version — core entities only)
        const bcrypt = await import('bcryptjs');
        const pwd = await bcrypt.hash('password123', 10);

        const tenant = await prisma.tenant.upsert({
            where: { slug: 'acme-corp' },
            update: {},
            create: { name: 'Acme Corp', slug: 'acme-corp', industry: 'Technology', maxRiskScale: 5 },
        });

        const adminEmail = 'admin@acme.com';
        const admin = await prisma.user.upsert({
            where: { emailHash: hashForLookup(adminEmail) },
            update: {},
            create: { email: adminEmail, emailHash: hashForLookup(adminEmail), passwordHash: pwd, name: 'Alice Admin' },
        });

        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: tenant.id, userId: admin.id } },
            update: {},
            create: { tenantId: tenant.id, userId: admin.id, role: 'ADMIN' },
        });

        const counts = {
            tenants: await prisma.tenant.count(),
            users: await prisma.user.count(),
            controls: await prisma.control.count({ where: { tenantId: tenant.id } }),
            frameworks: await prisma.framework.count(),
        };

        logger.info('Staging seed completed', { component: 'staging-seed', ...counts });

        return jsonResponse({
            success: true,
            message: 'Staging seed completed',
            counts,
            login: { email: 'admin@acme.com', password: 'password123' },
        });
    } catch (err) {
        logger.error('Staging seed failed', { component: 'staging-seed', error: err instanceof Error ? err.message : String(err) });
        return jsonResponse(
            { error: 'Seed failed', details: String(err) },
            { status: 500 }
        );
    } finally {
        await prisma.$disconnect();
    }
}
