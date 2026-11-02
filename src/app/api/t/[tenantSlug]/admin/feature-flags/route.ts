import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { assertPlatformSupport } from '@/lib/auth/platform-support';
import { flagsForcedOff } from '@/lib/feature-flags';
import {
    listFeatureFlags,
    listCohortSizes,
    upsertFeatureFlag,
} from '@/app-layer/usecases/feature-flag-admin';
import { UpsertFlagBody } from '@/app-layer/schemas/feature-flag-admin.schemas';

/**
 * «Функции» — the superuser's flag switches (#2706).
 *
 * Owner, 2026-11-01: a web page only the platform superuser sees, with on/off
 * switches for `usage.events`, `assistant.enabled` and the other platform
 * flags. It is how they turn usage on without a terminal.
 *
 * ## A SECOND DOOR, because the page cannot use the first one
 *
 * `/api/admin/feature-flags` is gated by `verifyPlatformApiKey` — a shared
 * `PLATFORM_ADMIN_API_KEY` — and sits in `PUBLIC_PATH_PREFIXES` because the
 * Edge calls `getToken()`, which understands only a NextAuth cookie, so a
 * keyed request would be 401'd before the handler ran.
 *
 * A browser page therefore has no way in. It holds no key, and shipping one
 * would be a credential leak: `NEXT_PUBLIC_*` is inlined at BUILD time, so the
 * key would be in every user's bundle rather than only the superuser's. Asking
 * the operator to paste it into a form is worse than the terminal it replaces
 * — a long-lived platform credential in browser memory, autofill and probably
 * a password manager, to save typing one `curl`.
 *
 * So this is a second door for a PERSON, not a replacement. The keyed routes
 * stay exactly as they are, for scripts and for an incident where the session
 * path is the thing that is broken.
 *
 * ## The two gates, and why `admin.manage` alone is not one
 *
 * `requirePermission('admin.manage')` is necessary and NOT sufficient:
 * permissions resolve from Role, so every tenant's admin holds it, and
 * `FeatureFlag` has no `tenantId` — one farm's admin could launch a feature
 * for every other farm. `assertPlatformSupport(ctx)` restricts this to the
 * designated platform tenant and 404s everywhere else, so an unrelated
 * tenant's owner is not even told the console exists. That is the promotions
 * console's arrangement verbatim, and it is why this route needs no
 * `PUBLIC_PATH` entry: the session cookie is what the Edge already reads.
 *
 * ## ONE request, not two
 *
 * The response carries the flags, `forcedOff` and the cohort SIZES together,
 * where the keyed console splits the sizes onto `/cohorts`. The page needs all
 * three to render a true answer and a partial render here is a wrong one:
 *
 *   • `forcedOff` overrides every row, so a page showing `enabled: true` while
 *     every client sees the flag off is worse than no page at all. It is
 *     deliberately not clearable from any API — the switch exists for when the
 *     application is the thing going wrong — so the page displays it and says
 *     clearing it is an operator action on the VM.
 *   • a cohort with zero members makes an ENABLED flag off for everyone while
 *     reading as a live rollout, which the flag row alone cannot show.
 *
 * The rows are the RAW table, never a resolved per-caller view: an operator
 * opens this screen precisely to see that a flag is enabled-but-cohort-gated,
 * which `/api/auth/me` collapses to one boolean on purpose.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        // Sequential, not `Promise.all`: two independent reads whose combined
        // cost is two fast queries, and nothing here is on a hot path.
        const flags = await listFeatureFlags();
        const cohorts = await listCohortSizes();
        return jsonResponse({ flags, cohorts, forcedOff: flagsForcedOff() });
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        assertPlatformSupport(ctx);
        const body = UpsertFlagBody.parse(await req.json());

        const flag = await upsertFeatureFlag({
            key: body.key,
            enabled: body.enabled,
            // Resolved HERE rather than defaulted in the usecase, so the write
            // is always explicit: `undefined` in a Prisma `update` means "leave
            // it alone", and omitting cohorts must mean "everyone", not "keep
            // whatever narrowing was there". The keyed route says the same.
            cohorts: body.cohorts ?? [],
            description: body.description,
            // FROM THE SESSION, never the body. `UpsertFlagBody` has no such
            // field, so a caller cannot supply one — which is what keeps the
            // usecase's rule intact: a caller-supplied name in an attribution
            // field is worse than an absent one, and this is not
            // caller-supplied.
            actorUserId: ctx.userId,
        });

        return jsonResponse({ flag, forcedOff: flagsForcedOff() });
    }),
);

export const runtime = 'nodejs';
