/**
 * Platform flag administration — the five operations behind the flag console.
 *
 * ── why this is a usecase and not Prisma in the route ──
 *
 * `tests/unit/no-direct-prisma.test.ts` bans direct `prisma.` from route
 * handlers, and it caught the first version of this surface doing exactly
 * that. The shape is already precedented twice: `agri-events.ts` and
 * `news-derived-events.ts` are GLOBAL catalogues (no `tenantId`, no RLS) whose
 * platform-admin writes arrive from `PLATFORM_ADMIN_API_KEY`-gated routes with
 * no user session and therefore no `RequestContext` to carry. Both took the
 * same resolution: the queries live in a usecase on the global handle, listed
 * in that guard's `USECASE_ALLOWLIST` with the reason written down. There is no
 * `tenantId` to filter on here either, so the global handle carries no RLS
 * risk.
 *
 * The functions take plain arguments rather than a `RequestContext`, for the
 * same reason `createTenantWithOwner` does: at the moment a platform key is
 * verified there is no user and no tenant in scope, so a context parameter
 * would be a shape with nothing to put in it.
 *
 * ── what is deliberately NOT here ──
 *
 * `FEATURE_FLAGS_FORCE_OFF`. It is an environment variable read per request by
 * `flagsForcedOff()`, and no function in this module can change it. An API that
 * could clear the kill switch would be an API that can be compromised into
 * clearing it, and the switch exists for the case where the application is the
 * thing going wrong.
 */
import { prisma } from '@/lib/prisma';
import { invalidateFlagCache } from '@/lib/feature-flags';
import { logger } from '@/lib/observability/logger';
import { sanitizePlainText } from '@/lib/security/sanitize';

/** One row as the console renders it — the STORED state, not a resolved view. */
export interface FlagAdminRow {
    key: string;
    enabled: boolean;
    cohorts: string[];
    description: string | null;
    updatedAt: Date;
}

export interface UpsertFlagInput {
    key: string;
    enabled: boolean;
    /** Always explicit. See the comment on the write below. */
    cohorts: string[];
    /** `undefined` leaves it alone; `null` clears it. */
    description?: string | null;
}

/** Bounded so one cohort cannot return an unbounded body. */
export const COHORT_MEMBER_PAGE_SIZE = 500;

const FLAG_SELECT = {
    key: true,
    enabled: true,
    cohorts: true,
    description: true,
    updatedAt: true,
} as const;

/**
 * Every flag, ordered by key so the list is stable between reloads.
 *
 * The RAW table, not a per-caller resolution: an operator needs to see that a
 * flag is enabled-but-cohort-gated, which `/api/auth/me` deliberately collapses
 * to one boolean. Reporting the resolved value would hide exactly the state
 * someone opens the console to inspect.
 */
export async function listFeatureFlags(): Promise<FlagAdminRow[]> {
    return prisma.featureFlag.findMany({ orderBy: { key: 'asc' }, select: FLAG_SELECT });
}

/**
 * Create or update one flag, then make the change visible.
 *
 * An upsert rather than separate create/update: the key IS the identity, and a
 * console that errors on "already exists" makes the caller read first for no
 * benefit.
 */
export async function upsertFeatureFlag(input: UpsertFlagInput): Promise<FlagAdminRow> {
    // #1222: `description` is encrypted at rest (declared with the fan-out
    // narrowing; production holds a `v1:` row, under the global KEK because a
    // platform-admin write resolves no tenant DEK). Encrypted business text
    // owes a sanitiser at the write seam — the flag console renders this back,
    // and the author being a platform admin lowers the risk without removing
    // the surface.
    const description =
        input.description === undefined
            ? undefined
            : input.description != null
              ? sanitizePlainText(input.description)
              : null;
    const flag = await prisma.featureFlag.upsert({
        where: { key: input.key },
        create: {
            key: input.key,
            enabled: input.enabled,
            cohorts: input.cohorts,
            description: description ?? null,
        },
        update: {
            enabled: input.enabled,
            // Always written, never left undefined. `undefined` in a Prisma
            // `update` means "leave it alone", so omitting cohorts on a flag
            // that HAS them would quietly keep the old narrowing while the
            // operator believes they just opened it to everyone. The caller
            // resolves an absent list to `[]` for that reason.
            cohorts: input.cohorts,
            // `description` keeps the three-state contract: absent leaves it,
            // explicit null clears it.
            ...(description !== undefined ? { description } : {}),
        },
        // `updatedByUserId` is left NULL, and that is the honest answer rather
        // than a gap: the credential upstream is a platform API key, so there
        // is no user in scope to record. Taking an actor id from the request
        // would put a caller-supplied name in an attribution field, which is
        // worse than an absent one. The record of WHO flipped a flag is the
        // operator's access to the key plus the log line below; a real platform
        // audit chain is P1.9 (`PlatformAuditLog`), and this is one of its
        // first writers.
        select: FLAG_SELECT,
    });

    // Without this the flip is invisible for up to 30s — `readFlagTable`
    // caches the table — and an operator watching for it would reasonably
    // conclude the console was broken and flip it again. The TTL remains the
    // backstop for a Redis that dropped the DEL.
    await invalidateFlagCache();

    // A flag flip is a deployment event. The key and resulting state, never
    // the caller's key material — which the verifier never exposes anyway.
    logger.info('feature-flag.updated', {
        component: 'feature-flags',
        key: flag.key,
        enabled: flag.enabled,
        cohortCount: flag.cohorts.length,
    });

    return flag;
}

/**
 * Every cohort that has at least one member, with its size.
 *
 * This answers the question an operator actually arrives with — "which cohorts
 * exist, and are any of them empty?" — which the flag list cannot: a flag names
 * cohorts that may have no members at all, and an enabled flag gated on an
 * empty cohort is OFF for everyone while reading as a live rollout.
 *
 * A cohort with zero members does not appear, because there is no row to
 * group — which is why the flag list and this list are read together.
 */
export async function listCohortSizes(): Promise<Array<{ cohort: string; members: number }>> {
    const grouped = await prisma.featureFlagCohortMember.groupBy({
        by: ['cohortKey'],
        _count: { _all: true },
        orderBy: { cohortKey: 'asc' },
    });
    return grouped.map((g) => ({ cohort: g.cohortKey, members: g._count._all }));
}

/** Members of one cohort, bounded, saying so when the page was cut short. */
export async function listCohortMembers(cohort: string): Promise<{
    members: Array<{ userId: string; createdAt: Date }>;
    truncated: boolean;
}> {
    const members = await prisma.featureFlagCohortMember.findMany({
        where: { cohortKey: cohort },
        select: { userId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: COHORT_MEMBER_PAGE_SIZE,
    });
    // Surfaced rather than silently truncated: a console showing 500 of 900
    // members without saying so is a console an operator trusts wrongly.
    return { members, truncated: members.length === COHORT_MEMBER_PAGE_SIZE };
}

/**
 * Add a user to a cohort. Idempotent.
 *
 * `@@unique([cohortKey, userId])` makes a double-add a P2002 — the right
 * outcome for the database and the wrong one for a console, where re-running an
 * add should be a no-op rather than an error to interpret. So the constraint is
 * relied on and the conflict swallowed with `skipDuplicates`, not a
 * read-then-write, which would race.
 *
 * No cache invalidation, and that omission is deliberate rather than
 * forgotten: `cohortsFor` reads membership per request and is NOT cached (see
 * the module docblock in `@/lib/feature-flags`), so the change is visible on
 * the caller's next request. Dropping the flag table's cache here would cost
 * every flag read a database round-trip to no effect.
 */
export async function addCohortMember(cohort: string, userId: string): Promise<{ added: boolean }> {
    // The FK to `User` refuses a typo'd id. `cohortKey` has no FK by design — a
    // cohort is a label — so a typo'd COHORT silently creates a new empty one.
    // That asymmetry is why `listCohortSizes` exists.
    const result = await prisma.featureFlagCohortMember.createMany({
        data: [{ cohortKey: cohort, userId }],
        skipDuplicates: true,
    });

    logger.info('feature-flag.cohort_member_added', {
        component: 'feature-flags',
        cohort,
        // `created: 0` means they were already a member — the idempotent path.
        created: result.count,
    });

    return { added: result.count === 1 };
}

/**
 * Remove a user from a cohort. Idempotent, and succeeds for a non-member.
 *
 * `deleteMany` rather than `delete`, because `delete` throws P2025 on a missing
 * row and "they are not in the cohort" is the state the caller asked for. The
 * COUNT is returned so the caller can tell the two apart — a delete that
 * removed zero rows must not report as a delete.
 */
export async function removeCohortMember(cohort: string, userId: string): Promise<{ removed: number }> {
    const result = await prisma.featureFlagCohortMember.deleteMany({
        where: { cohortKey: cohort, userId },
    });

    logger.info('feature-flag.cohort_member_removed', {
        component: 'feature-flags',
        cohort,
        removed: result.count,
    });

    return { removed: result.count };
}
