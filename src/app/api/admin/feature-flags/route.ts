/**
 * Platform flag console — read and flip runtime feature flags.
 *
 * ── why this is platform-admin and not a tenant role ──
 *
 * `FeatureFlag` has no `tenantId` by design (see `prisma/schema/social.prisma`):
 * a dark-launch rail is flipped for the whole deployment, and the surfaces it
 * gates are person-scoped rather than farm-scoped. So the gate is
 * `X-Platform-Admin-Key`, the same one `/api/admin/tenants` uses — not
 * `admin.manage`, which an ADMIN of any single tenant holds. A tenant admin
 * being able to launch a feature for every other tenant would be the wrong
 * boundary, and it is the obvious mistake here.
 *
 * ── flipping a flag invalidates the cache, and that is the whole point ──
 *
 * `readFlagTable` caches for 30s, so without an explicit invalidation a flip
 * would take up to 30s to be visible and an operator watching for it would
 * reasonably conclude the console was broken and flip it again. The write path
 * therefore calls `invalidateFlagCache()`; the TTL remains the backstop for a
 * Redis that dropped the DEL.
 *
 * ── the kill switch is NOT reachable from here, deliberately ──
 *
 * `FEATURE_FLAGS_FORCE_OFF` is an environment variable read per request, and it
 * stays that way. An API that could clear the kill switch would be an API that
 * can be compromised into clearing it; the switch exists for the case where the
 * application is the thing going wrong. Turning it off is an operator action on
 * the VM.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { prisma } from '@/lib/prisma';
import {
    invalidateFlagCache,
    flagsForcedOff,
    FLAG_KEY_PATTERN,
    FLAG_KEY_MAX_LENGTH,
} from '@/lib/feature-flags';
import { logger } from '@/lib/observability/logger';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

/**
 * A flag key, held to the grammar `@/lib/feature-flags` publishes.
 *
 * Imported rather than spelled here because the flag-gating guard holds every
 * social route's key to the same pattern, and a console that accepted keys the
 * guard rejects (or the reverse) would let a route ship gated on a flag nobody
 * can create. See `FLAG_KEY_PATTERN`'s docblock.
 */
const FlagKey = z
    .string()
    .min(1)
    .max(FLAG_KEY_MAX_LENGTH)
    .regex(FLAG_KEY_PATTERN, 'keys are dotted lowercase, e.g. social.profiles');

const UpsertBody = z.object({
    key: FlagKey,
    enabled: z.boolean(),
    /**
     * Cohort names. EMPTY means "everyone, once enabled"; non-empty NARROWS.
     * Capped so one request cannot grow the row without bound — the resolver
     * reads every cohort on every request that touches flags.
     */
    cohorts: z.array(z.string().min(1).max(64)).max(20).optional(),
    description: z.string().max(500).nullable().optional(),
});

/** Convert the verifier's typed failure into its HTTP answer. */
function platformGate(req: NextRequest): NextResponse | null {
    try {
        verifyPlatformApiKey(req);
        return null;
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
}

/**
 * Every flag, with its stored state.
 *
 * This is the RAW table, not a resolved view: an operator needs to see that a
 * flag is enabled-but-cohort-gated, which `/api/auth/me` deliberately collapses
 * to a single boolean per caller. Reporting the resolved value here would hide
 * exactly the state someone opens the console to inspect.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    const flags = await prisma.featureFlag.findMany({
        orderBy: { key: 'asc' },
        select: { key: true, enabled: true, cohorts: true, description: true, updatedAt: true },
    });

    return jsonResponse({
        flags,
        /**
         * Surfaced because it overrides every row above. Without it the console
         * would show `enabled: true` while every client sees the flag off, and
         * the operator would have no way to tell from this screen.
         */
        forcedOff: flagsForcedOff(),
    });
});

/**
 * Create or update one flag.
 *
 * An upsert rather than separate create/update: the key IS the identity, and a
 * console that errors on "already exists" makes the caller do a read first for
 * no benefit.
 */
export const PUT = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }
        const body = UpsertBody.parse(raw);
        const cohorts = body.cohorts ?? [];

        // `updatedByUserId` is left NULL, and that is the honest answer rather
        // than a gap: the credential here is a platform API key, so there is no
        // user in scope to record. Accepting an actor id from the body would put
        // a caller-supplied name in an attribution field, which is worse than an
        // absent one. The record of WHO flipped a flag is the operator's access
        // to the key plus the log line below; a real platform audit chain is
        // P1.9 (`PlatformAuditLog`), and this route is one of its first writers.
        const flag = await prisma.featureFlag.upsert({
            where: { key: body.key },
            create: {
                key: body.key,
                enabled: body.enabled,
                cohorts,
                description: body.description ?? null,
            },
            update: {
                enabled: body.enabled,
                cohorts,
                ...(body.description !== undefined ? { description: body.description } : {}),
            },
            select: { key: true, enabled: true, cohorts: true, description: true, updatedAt: true },
        });

        // Without this the flip is invisible for up to 30s and an operator
        // would reasonably flip it again.
        await invalidateFlagCache();

        // A flag flip is a deployment event. Logged at INFO with the key and the
        // resulting state — never the caller's key material, which the verifier
        // never exposes anyway.
        logger.info('feature-flag.updated', {
            component: 'feature-flags',
            key: flag.key,
            enabled: flag.enabled,
            cohortCount: flag.cohorts.length,
        });

        return jsonResponse({ flag, forcedOff: flagsForcedOff() });
    },
    {
        // Same pre-auth tier as the other platform-admin surfaces: the header IS
        // the credential, so this sits in the same abuse position as sign-in.
        rateLimit: { config: LOGIN_LIMIT, scope: 'platform-flag-console' },
    },
);
