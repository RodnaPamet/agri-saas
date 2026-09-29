/**
 * GET /api/health
 *
 * LEGACY compatibility endpoint — semantically equivalent to /api/readyz.
 *
 * Retained for backward compatibility with existing monitoring
 * configurations and load balancers. New deployments should use:
 *   - /api/livez  — liveness probe (always 200 if process is up)
 *   - /api/readyz — readiness probe (checks DB + Redis)
 *
 * Per GAP-13 this endpoint now also pings Redis (parity with readyz)
 * so an operator pointing legacy probes here won't get a misleading
 * "healthy" reading while Redis is down. In production REDIS_URL is
 * required (`src/env.ts` superRefine), so a missing-config Redis
 * check signals a real degradation.
 *
 * @deprecated Use /api/livez and /api/readyz instead.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { jsonResponse } from '@/lib/api-response';
import { SERVICE_ID } from '@/lib/service-identity';

// Prisma 7 — `new PrismaClient()` requires an adapter. The probe
// constructs a standalone client (deliberately not the app
// singleton) so it never trips the audit / soft-delete extensions
// while pinging the DB.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

interface CheckResult {
    status: 'ok' | 'error';
    latencyMs?: number;
    error?: string;
}

async function checkDatabase(): Promise<CheckResult> {
    const start = Date.now();
    try {
        await prisma.$queryRaw`SELECT 1`;
        return { status: 'ok', latencyMs: Date.now() - start };
    } catch {
        return { status: 'error', latencyMs: Date.now() - start, error: 'Connection failed' };
    }
}

// Redis ping. Mirrors `/api/readyz`. Reads `getRedis()` from
// `@/lib/redis` so the singleton client (and its connection pool)
// is reused across probes — never opens a new connection per
// request. The error-message strings are intentionally generic:
// no host/port/password leakage even on failure.
async function checkRedis(): Promise<CheckResult> {
    const isConfigured = !!process.env.REDIS_URL;
    if (!isConfigured) {
        // In production REDIS_URL is required by env validation, so
        // reaching this branch means env validation was bypassed
        // (SKIP_ENV_VALIDATION=1 or similar) or we're in dev/test.
        // Mark not_configured rather than ok so an operator sees
        // the real story; readyz makes the same distinction.
        return process.env.NODE_ENV === 'production'
            ? { status: 'error', latencyMs: 0, error: 'Not configured' }
            : { status: 'ok', latencyMs: 0 };
    }
    const start = Date.now();
    try {

        const { getRedis } = require('@/lib/redis') as typeof import('@/lib/redis');
        const client = getRedis();
        if (!client) {
            return { status: 'error', latencyMs: Date.now() - start, error: 'Client unavailable' };
        }
        const result = await client.ping();
        if (result !== 'PONG') {
            return { status: 'error', latencyMs: Date.now() - start, error: 'Unexpected ping response' };
        }
        return { status: 'ok', latencyMs: Date.now() - start };
    } catch {
        return { status: 'error', latencyMs: Date.now() - start, error: 'Ping failed' };
    }
}

export async function GET() {
    const start = Date.now();

    const [database, redis] = await Promise.all([
        checkDatabase(),
        checkRedis(),
    ]);

    const checks: Record<string, CheckResult> = { database, redis };
    const allOk = Object.values(checks).every((c) => c.status === 'ok');

    return jsonResponse(
        {
            service: SERVICE_ID,
            status: allOk ? 'healthy' : 'degraded',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            version: process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
            node: process.version,
            checks,
            latencyMs: Date.now() - start,
            _deprecated: 'Use /api/livez and /api/readyz instead',
        },
        { status: allOk ? 200 : 503 },
    );
}
