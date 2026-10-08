/**
 * POST /api/me/farms — the signed-in person creates a farm (P3.6).
 *
 * The final step of the registration wizard (P3.8), and the "add another farm"
 * action afterwards: a person may hold several farms (owner ruling 2026-10-06).
 *
 * ## Account-level, not tenant-scoped
 *
 * A new route class. There is no `[tenantSlug]`, deliberately — the caller
 * either has no farm yet or is adding one, so there is no tenant to scope to
 * and no `requirePermission` to apply. Authorisation is "are you signed in",
 * and the farm created belongs to the session user and nobody else: the owner
 * is resolved from the session, never from the body, so one person can never
 * create a farm owned by another.
 *
 * ## Why this is not a membership-creation site
 *
 * Memberships are invite-only (same ruling). This route creates a farm and its
 * creator's OWNER membership — which is not a "join": invite-only governs
 * joining an EXISTING farm. The membership itself is written by
 * `createTenantWithOwner` in `tenant-lifecycle.ts`, already on
 * `ALLOWLISTED_MEMBERSHIP_SITES`, so neither this file nor the usecase touches
 * `tenantMembership` and `tests/guardrails/no-auto-join.test.ts` stays at eight
 * allowlisted sites.
 *
 * ## Rate limiting
 *
 * The default `API_MUTATION_LIMIT` from `withApiErrorHandling`, which since
 * #1161 keys by `u:<sub>` with no opt-in from the route — so one farmer on a
 * carrier-NAT address cannot spend another subscriber's budget. A dedicated
 * tighter bucket for farm creation is arguable (a farm is expensive to make),
 * but it would be a new policy rather than a preset, and the per-user key is
 * what actually bounds abuse here.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { auth } from '@/auth';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { unauthorized, codedBadRequest } from '@/lib/errors/types';
import { getRequestContext } from '@/lib/observability/context';
import { assertFeatureEnabled } from '@/lib/feature-flags';
import { createFarmForUser, FARM_NAME_MAX } from '@/app-layer/usecases/farm-creation';
import { listMyFarms } from '@/app-layer/usecases/my-farms';

const CreateFarmSchema = z.object({
    name: z.string().min(1).max(FARM_NAME_MAX),
    /**
     * Optional. «Стопанство с ЕИК» supplies one; «Земеделски стопанин —
     * физическо лице» does not.
     *
     * Bounded at 13 because an ЕИК is 9 or 13 digits — the checksum and the
     * ЕГН refusal both live in the usecase, which is the only place that may
     * decide what happens to the value. Length is all that is enforced here,
     * so the route cannot develop a second, drifting opinion about validity.
     */
    eik: z.string().trim().max(13).optional().nullable(),
});

/**
 * The dark-launch rail. `src/app/api/me/**` is classified SOCIAL by
 * `tests/guards/social-routes-are-flag-gated.test.ts`, and this is the first
 * route to make that set non-empty — so the gate requirement bites here for the
 * first time rather than having been quietly satisfied by there being nothing
 * to check.
 *
 * Correct rather than incidental: P3 is the [social] roadmap, and its own
 * design note says a dark-launch rail has to be flippable for the whole
 * deployment. `assertFeatureEnabled` throws **404, not 403** — a dark-launched
 * surface must not be discoverable, and 403 would confirm the feature is real.
 *
 * The flag is OFF until someone creates the row: a flag that does not exist is
 * off. P3.8's wizard and any E2E that drives it must enable
 * `social.farm-registration` first.
 */
const FARM_REGISTRATION_FLAG = 'social.farm-registration';

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const session = await auth();
    if (!session?.user?.id) throw unauthorized();
    await assertFeatureEnabled(FARM_REGISTRATION_FLAG, session.user.id);
    // `createTenantWithOwner` resolves the OWNER by email, so a session with no
    // email cannot create a farm. Refused rather than defaulted: a placeholder
    // would mint a User row nobody can ever sign in as, and make it the owner.
    if (!session.user.email) throw codedBadRequest('ACCOUNT_HAS_NO_EMAIL', 'Your account has no email address.');

    const parsed = CreateFarmSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw codedBadRequest('INVALID_FARM_PAYLOAD', 'Invalid farm payload.');

    const result = await createFarmForUser(
        {
            requestId: getRequestContext()?.requestId ?? crypto.randomUUID(),
            userId: session.user.id,
            userEmail: session.user.email,
        },
        { name: parsed.data.name, eik: parsed.data.eik ?? null },
    );

    return jsonResponse(result, { status: 201 });
});

/**
 * GET /api/me/farms — the farms the caller belongs to, for a farm switcher.
 *
 * ## UNGATED, unlike the POST above, and that asymmetry is deliberate
 *
 * Requested by agrent-ios and agreed: if `social.farm-registration` is ever
 * switched off, a person must still be able to move between farms they already
 * belong to. Only *adding* a farm follows the flag. Being unable to reach a
 * farm you are a member of is a worse failure than being unable to create one,
 * and a dark-launch rail is meant to gate new surface rather than strand
 * existing access.
 *
 * **A weakness in the gate check this exposes**, worth knowing before someone
 * adds a third handler here: `tests/guards/social-routes-are-flag-gated.test.ts`
 * reads the FILE and asserts it contains a gate call. It is satisfied by the
 * POST, so an ungated GET in the same file passes silently. That is correct
 * here and would be wrong for a handler that should be gated, so the guard
 * cannot be relied on per-handler. Raised separately.
 *
 * ## Ordering is a contract, not a convenience
 *
 * `farms[0]` is the oldest active membership, which is the same farm
 * `/api/auth/me` names — so a client can reconcile this list against the farm
 * it opens on a fresh install. That only holds because #1389 gave `/me` the
 * same `deletedAt` predicate.
 */
export const GET = withApiErrorHandling(async () => {
    const session = await auth();
    if (!session?.user?.id) throw unauthorized();

    const farms = await listMyFarms(session.user.id);
    return jsonResponse({ farms }, { status: 200 });
});
