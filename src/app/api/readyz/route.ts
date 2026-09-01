/**
 * GET /api/readyz
 *
 * Kubernetes-compatible readiness probe with real dependency checks.
 *
 * Returns 200 only when ALL critical dependencies are reachable.
 * Returns 503 with the failed component(s) named in the response when
 * any dependency is unavailable. The orchestrator should stop routing
 * traffic to this instance when 503.
 *
 * Checked dependencies:
 *   - PostgreSQL (via Prisma `SELECT 1`)
 *   - Redis (REQUIRED in production per GAP-13; skipped in dev/test
 *     when REDIS_URL is unset)
 *   - S3 (HeadBucket — Epic OI-3; skipped when STORAGE_PROVIDER != 's3')
 *
 * Each check has a 2-second timeout (CHECK_TIMEOUT_MS) so the probe
 * never blocks longer than ~2.1s end-to-end (checks run in parallel
 * via Promise.all). A hung dependency surfaces as `error: timeout`,
 * never as a probe that hangs forever.
 *
 * Skipped paths:
 *   - Redis is skipped when REDIS_URL is unset under dev/test only.
 *     Under NODE_ENV=production this is a configuration error and the
 *     probe returns 503 (defense-in-depth past the SKIP_ENV_VALIDATION
 *     escape hatch).
 *   - Storage is skipped when STORAGE_PROVIDER != 's3' (local-dev
 *     using filesystem storage). Production sets STORAGE_PROVIDER=s3
 *     via the chart's runtime ConfigMap.
 *
 * Response shape (machine-readable for probe automation):
 *   {
 *     "status":    "ready" | "not_ready",
 *     "timestamp": ISO-8601,
 *     "uptime":    number (seconds),
 *     "version":   string (BUILD_SHA or 'dev'),
 *     "checks": {
 *       "database": { "status": "ok" | "error", "latencyMs": N, "error"?: "..." },
 *       "redis":    { "status": "ok" | "error" | "skipped", ... },
 *       "storage":  { "status": "ok" | "error" | "skipped", ... }
 *     },
 *     "failed":    string[]   // names of components that failed
 *     "capabilities": {
 *       // Degradable, OPTIONAL features — reported for operator
 *       // observability, never part of `checks`/`failed`, so they can
 *       // never 503 the probe.
 *       "satellite": { "configured": boolean, "missing": string[] },
 *       "basemap":   { "branch": "maptiler" | "demotiles" | "blind", ... }
 *     },
 *     "latencyMs": N           // total probe time
 *   }
 *
 * Error messages are bounded to a small enum (`Connection failed`,
 * `Ping failed`, `head_bucket_failed`, `timeout`, `Not configured`,
 * ...) so we never leak credentials or infrastructure details (e.g.
 * a Postgres connection error often includes the host/port/role in
 * its message).
 *
 * This endpoint NEVER throws — every check is wrapped in try/catch
 * and reported as a structured CheckResult.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '@/env';
import { geeConfigStatus } from '@/lib/agro/gee-config';
import { basemapBranchStatus } from '@/lib/geo/basemap-bundle-scan';
import { jsonResponse } from '@/lib/api-response';
import { logger } from '@/lib/observability/logger';

const CHECK_TIMEOUT_MS = 2000;

// Reuse module-level clients so probe traffic doesn't churn pools.
// Prisma 7 — adapter is required for connection initialisation.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

// Redis is optional — import dynamically to avoid a hard dependency
// on the cache layer in environments where it's unconfigured.
let getRedis: (() => import('ioredis').default | null) | undefined;
let isRedisConfigured = false;

try {

    const redisModule = require('@/lib/redis');
    getRedis = redisModule.getRedis;
    isRedisConfigured = !!process.env.REDIS_URL;
} catch {
    // Redis module not available — skip Redis checks
}

let _s3Client: S3Client | null = null;
function getS3Client(): S3Client {
    if (_s3Client) return _s3Client;

    // Mirrors src/lib/storage/s3-provider.ts::getS3Client() so the
    // probe and the real upload path see the same backend.
    const config: ConstructorParameters<typeof S3Client>[0] = {
        region: env.S3_REGION || 'us-east-1',
    };
    if (env.S3_ENDPOINT) {
        config.endpoint = env.S3_ENDPOINT;
        config.forcePathStyle = true;
    }
    if (env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
        config.credentials = {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        };
    }
    _s3Client = new S3Client(config);
    return _s3Client;
}

interface CheckResult {
    status: 'ok' | 'error' | 'skipped';
    latencyMs: number;
    error?: string;
}

/**
 * Race a promise against a per-check timeout. The timeout error
 * carries the literal string "<dep>_timeout" so callers can map it
 * to a structured `error: 'timeout'` value without parsing free-
 * form error strings (which can carry creds).
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label}_timeout`)),
                    ms,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function classifyError(err: unknown, defaultCode: string): string {
    if (err instanceof Error && err.message.endsWith('_timeout')) return 'timeout';
    return defaultCode;
}

async function checkDatabase(): Promise<CheckResult> {
    const start = Date.now();
    try {
        await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS, 'database');
        return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
        return {
            status: 'error',
            latencyMs: Date.now() - start,
            error: classifyError(err, 'Connection failed'),
        };
    }
}

async function checkRedis(): Promise<CheckResult> {
    if (!isRedisConfigured || !getRedis) {
        // GAP-13 — In production REDIS_URL is required by the env
        // schema (`src/env.ts`). Reaching this branch under prod
        // means validation was bypassed (SKIP_ENV_VALIDATION) or
        // the module failed to load — either way, surface the
        // misconfiguration rather than report a false "ready".
        return process.env.NODE_ENV === 'production'
            ? { status: 'error', latencyMs: 0, error: 'Not configured' }
            : { status: 'skipped', latencyMs: 0 };
    }
    const start = Date.now();
    try {
        const client = getRedis();
        if (!client) {
            return { status: 'error', latencyMs: Date.now() - start, error: 'Client unavailable' };
        }
        const result = await withTimeout(client.ping(), CHECK_TIMEOUT_MS, 'redis');
        if (result !== 'PONG') {
            return { status: 'error', latencyMs: Date.now() - start, error: 'Unexpected ping response' };
        }
        return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
        return {
            status: 'error',
            latencyMs: Date.now() - start,
            error: classifyError(err, 'Ping failed'),
        };
    }
}

async function checkStorage(): Promise<CheckResult> {
    if (env.STORAGE_PROVIDER !== 's3') {
        return { status: 'skipped', latencyMs: 0 };
    }
    if (!env.S3_BUCKET) {
        // Misconfiguration — STORAGE_PROVIDER=s3 but no bucket means
        // the runtime is incomplete; surface as 'error' so the pod
        // stays NotReady and the operator notices at boot.
        return { status: 'error', latencyMs: 0, error: 'bucket_not_configured' };
    }
    const start = Date.now();
    try {
        await withTimeout(
            getS3Client().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })),
            CHECK_TIMEOUT_MS,
            'storage',
        );
        return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
        return {
            status: 'error',
            latencyMs: Date.now() - start,
            error: classifyError(err, 'head_bucket_failed'),
        };
    }
}

export async function GET() {
    const start = Date.now();

    // Run all three checks in parallel for minimum probe latency.
    // Each has its own timeout so a single hung dependency can't
    // delay the others.
    const [database, redis, storage] = await Promise.all([
        checkDatabase(),
        checkRedis(),
        checkStorage(),
    ]);

    // Stable response shape — checks.redis and checks.storage are
    // always present so probe consumers don't need to check for key
    // existence. Under dev/test without REDIS_URL the redis entry
    // reports `status: 'skipped'` (counts as ready). Under prod a
    // missing REDIS_URL still surfaces as `status: 'error'` per
    // GAP-13 (defense-in-depth past SKIP_ENV_VALIDATION).
    const checks: Record<string, CheckResult> = { database, redis, storage };

    // 'skipped' counts as ready — those services aren't configured
    // for this deployment (local dev). Only 'error' fails the probe.
    const failed = Object.entries(checks)
        .filter(([, c]) => c.status === 'error')
        .map(([name]) => name);

    const allOk = failed.length === 0;

    // OPTIONAL CAPABILITIES — reported, never gating.
    //
    // Satellite (Google Earth Engine) is a degradable capability, not a
    // dependency: with no credentials `/farm-risk` shows "no data" levels and
    // the field briefing runs without satellite input — both by design. But a
    // prod deploy that lost its GEE keys would go dark SILENTLY, so the state is
    // surfaced here for operators (and dashboards) to alert on. It is
    // deliberately OUTSIDE `checks`/`failed` so it can never 503 the probe.
    const satellite = geeConfigStatus();

    // Basemap branch (#781). Same argument as satellite, different silence: the
    // map keeps WORKING when the MapTiler key is missing — it just falls back
    // to a third-party demo CDN. There is no error to alert on, which is why
    // nothing noticed. `resolveBasemapStyle` reads a build-time-inlined var, so
    // the only honest place to read the answer is the shipped bundle itself;
    // the workflow, the Dockerfile ARG and the code that READS the var all
    // report the same thing on both branches. Memoized after the first probe
    // (~90ms one-time over ~560 chunk files), OUTSIDE `checks`/`failed`, and
    // the result is a closed enum — the key never appears in the response.
    const basemap = await basemapBranchStatus();

    if (!allOk) {
        // Log the failure for observability — operators want to see
        // readyz failures in the logs even though the probe response
        // is the canonical signal. Don't log full error messages —
        // they may carry creds; the structured response body has the
        // bounded error codes for operators.
        logger.warn('readyz: dependency check failed', {
            component: 'readyz',
            failed,
        });
    }

    return jsonResponse(
        {
            status: allOk ? 'ready' : 'not_ready',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            version: process.env.BUILD_SHA || process.env.VERCEL_GIT_COMMIT_SHA || 'dev',
            checks,
            failed,
            capabilities: { satellite, basemap },
            latencyMs: Date.now() - start,
        },
        { status: allOk ? 200 : 503 },
    );
}
