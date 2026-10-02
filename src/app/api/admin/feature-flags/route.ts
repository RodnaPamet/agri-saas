/**
 * Platform flag console — read and flip runtime feature flags.
 *
 * HTTP boundary only: verify the platform key, parse, call the usecase, shape
 * the response. Every Prisma query, the cache invalidation and the log line
 * live in `@/app-layer/usecases/feature-flag-admin` — the layer rule, and
 * `tests/unit/no-direct-prisma.test.ts` enforces it on route handlers.
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
 * ── it has to be REACHABLE, which the gate below cannot tell you ──
 *
 * The Edge calls `getToken()`, which understands only a NextAuth JWE, so an
 * `x-platform-admin-key` request yields null and is 401'd before this handler
 * runs — the SCIM / `iflk_` / signed-webhook shape, six prior instances. Both
 * paths are therefore opened in `src/lib/auth/guard.ts`, as an EXACT entry plus
 * a children prefix so a neighbouring path is not opened with them.
 * `tests/unit/admin-feature-flags-console.test.ts` asserts both halves.
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
import { flagsForcedOff, FLAG_KEY_PATTERN, FLAG_KEY_MAX_LENGTH } from '@/lib/feature-flags';
import { listFeatureFlags, upsertFeatureFlag } from '@/app-layer/usecases/feature-flag-admin';
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

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    return jsonResponse({
        flags: await listFeatureFlags(),
        /**
         * Surfaced because it overrides every row above. Without it the console
         * would show `enabled: true` while every client sees the flag off, and
         * the operator would have no way to tell from this screen. The rows are
         * NOT rewritten to false — that would misreport what a flip-back does.
         */
        forcedOff: flagsForcedOff(),
    });
});

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

        const flag = await upsertFeatureFlag({
            key: body.key,
            enabled: body.enabled,
            // Resolved HERE rather than defaulted in the usecase, so the write
            // is always explicit: `undefined` in a Prisma `update` means "leave
            // it alone", and omitting cohorts must mean "everyone", not "keep
            // whatever narrowing was there".
            cohorts: body.cohorts ?? [],
            description: body.description,
        });

        return jsonResponse({ flag, forcedOff: flagsForcedOff() });
    },
    {
        // Same pre-auth tier as the other platform-admin surfaces: the header IS
        // the credential, so this sits in the same abuse position as sign-in.
        rateLimit: { config: LOGIN_LIMIT, scope: 'platform-flag-console' },
    },
);
