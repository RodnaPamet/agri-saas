/**
 * Platform flag console — cohort membership.
 *
 * ── why this route exists at all ──
 *
 * `FeatureFlag.cohorts` is the limited-rollout half of the flag design: enabled
 * AND a member of one of these cohorts. Without an operator path to POPULATE a
 * cohort, setting one makes the flag unreachable for everybody and the cohort
 * mechanism is inert — code-complete and never delivered. The sibling route
 * sets the cohort NAMES on a flag; this one puts people in them.
 *
 * ── no cache invalidation here, and that is not an omission ──
 *
 * `readFlagTable` caches the flag TABLE; `cohortsFor` reads membership per
 * request and is deliberately NOT cached (see the module docblock in
 * `@/lib/feature-flags`). So a membership change is visible on the caller's
 * next request, with no 30s window and nothing to invalidate. Copying the
 * sibling's `invalidateFlagCache()` call here would throw away every flag's
 * cached row to no effect.
 *
 * ── membership is by `userId`, not by email, until P1.1 ──
 *
 * Resolving an email would mean a 17th `hashForLookup` call site — added in the
 * week before P1.1 re-keys that derivation onto `LOOKUP_HMAC_KEY`, so it would
 * be a site that migration has to find and nothing would point it there. A
 * `userId` is stable across that change. `GET` lists the ids in a cohort so the
 * console is self-describing once the first member is in.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';

/**
 * A cohort name. Same bound as the sibling's `cohorts[]` entries, because the
 * two must agree: a name settable on a flag but not creatable here (or the
 * reverse) is a rollout an operator can half-configure.
 */
const CohortKey = z.string().min(1).max(64);

const MemberBody = z.object({
    cohort: CohortKey,
    userId: z.string().min(1).max(64),
});

/** Bounded so one cohort cannot return an unbounded body. */
const MEMBER_PAGE_SIZE = 500;

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
 * Members of one cohort, or every cohort's size when `cohort` is omitted.
 *
 * The no-argument form answers the question an operator actually arrives with —
 * "which cohorts exist, and are any of them empty?" — which the flag list
 * cannot answer: a flag names cohorts that may have no members at all, and an
 * enabled flag gated on an empty cohort is OFF for everyone while reading as a
 * live rollout.
 */
export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const refused = platformGate(req);
    if (refused) return refused;

    const cohort = req.nextUrl.searchParams.get('cohort');

    if (cohort === null) {
        const grouped = await prisma.featureFlagCohortMember.groupBy({
            by: ['cohortKey'],
            _count: { _all: true },
            orderBy: { cohortKey: 'asc' },
        });
        return jsonResponse({
            cohorts: grouped.map((g) => ({ cohort: g.cohortKey, members: g._count._all })),
        });
    }

    const parsed = CohortKey.safeParse(cohort);
    if (!parsed.success) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const members = await prisma.featureFlagCohortMember.findMany({
        where: { cohortKey: parsed.data },
        select: { userId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: MEMBER_PAGE_SIZE,
    });

    return jsonResponse({
        cohort: parsed.data,
        members,
        // Surfaced rather than silently truncated: a console that shows 500 of
        // 900 members without saying so is a console an operator trusts wrongly.
        truncated: members.length === MEMBER_PAGE_SIZE,
    });
});

/**
 * Add a user to a cohort. Idempotent.
 *
 * `@@unique([cohortKey, userId])` makes a double-add a P2002, which is the
 * right outcome for the DATABASE and the wrong one for a console: re-running an
 * add should be a no-op, not an error an operator has to interpret. So the
 * unique constraint is relied on and the conflict is swallowed — `createMany`
 * with `skipDuplicates` rather than a read-then-write, which would race.
 */
export const POST = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        let raw: unknown;
        try {
            raw = await req.json();
        } catch {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }
        const body = MemberBody.parse(raw);

        // The FK to `User` is what refuses a typo'd id; `cohortKey` has no FK by
        // design (a cohort is a label), so a typo'd COHORT silently creates a
        // new empty one. That asymmetry is why GET lists cohort sizes.
        const result = await prisma.featureFlagCohortMember.createMany({
            data: [{ cohortKey: body.cohort, userId: body.userId }],
            skipDuplicates: true,
        });

        logger.info('feature-flag.cohort_member_added', {
            component: 'feature-flags',
            cohort: body.cohort,
            // `created: 0` means it was already a member — the idempotent path.
            created: result.count,
        });

        return jsonResponse({ cohort: body.cohort, added: result.count === 1 });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-flag-cohorts' } },
);

/**
 * Remove a user from a cohort. Idempotent, and answers 200 for a non-member.
 *
 * `deleteMany` rather than `delete`, because `delete` throws P2025 on a missing
 * row and "they are not in the cohort" is the state the caller asked for. The
 * removed COUNT is returned so the operator can tell the two apart — the RLS
 * lesson: a delete that removes zero rows must not report as a delete.
 */
export const DELETE = withApiErrorHandling(
    async (req: NextRequest) => {
        const refused = platformGate(req);
        if (refused) return refused;

        const params = req.nextUrl.searchParams;
        const parsed = MemberBody.safeParse({
            cohort: params.get('cohort'),
            userId: params.get('userId'),
        });
        if (!parsed.success) {
            return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
        }

        const result = await prisma.featureFlagCohortMember.deleteMany({
            where: { cohortKey: parsed.data.cohort, userId: parsed.data.userId },
        });

        logger.info('feature-flag.cohort_member_removed', {
            component: 'feature-flags',
            cohort: parsed.data.cohort,
            removed: result.count,
        });

        return jsonResponse({ cohort: parsed.data.cohort, removed: result.count });
    },
    { rateLimit: { config: LOGIN_LIMIT, scope: 'platform-flag-cohorts' } },
);
