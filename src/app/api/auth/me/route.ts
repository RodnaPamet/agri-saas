import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { parseBottomTabOrder } from '@/lib/account/bottom-tabs';
import { resolveFlags } from '@/lib/feature-flags';

export const GET = withApiErrorHandling(async () => {
    const session = await auth();
    if (!session?.user) {
        return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { id: session.user.id },
        select: {
            id: true,
            email: true,
            name: true,
            // The effective avatar, on the query this handler ALREADY runs —
            // see `avatarUrl` below for why one column answers all three cases.
            image: true,
            bottomTabOrder: true,
            tenantMemberships: {
                // `tenant: { deletedAt: null }` is #1389. Without it this
                // handler could name a SOFT-DELETED farm as the caller's
                // current one: removing a tenant sets only `Tenant.deletedAt`
                // and deliberately leaves memberships ACTIVE, so a removed
                // farm still has live memberships pointing at it.
                //
                // Every other consumer already filtered it — the JWT claims
                // (`auth.ts:192`), the tenant picker, the tenant resolver, the
                // portfolio and the org listing — and `deleteTenantUnderOrg`'s
                // docblock asserts the tenant "becomes inaccessible
                // immediately, everywhere". This was the one place that did
                // not, and it is the payload every client parses.
                //
                // The native client reads this for the starting farm on a
                // first sign-in (agrent-ios#180), so before this a person
                // whose oldest membership was to a removed farm opened it and
                // met 404s on every screen. `tenant: null` now, which is what
                // the comment below already says `null` means.
                where: { status: 'ACTIVE', tenant: { deletedAt: null } },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: {
                    role: true,
                    tenant: { select: { id: true, name: true, slug: true } },
                },
            },
        },
    });

    const membership = user?.tenantMemberships[0];

    // Flags resolved FOR THIS USER, on the launch request the client already
    // makes. Cohort-gated flags are therefore already narrowed — a client never
    // sees a flag that is enabled for someone else, so it cannot accidentally
    // render a surface it is not in the cohort for.
    const featureFlags = await resolveFlags(session.user.id ?? null);

    return jsonResponse({
        user: {
            id: user?.id,
            email: user?.email,
            name: user?.name,
            /**
             * The caller's EFFECTIVE avatar, or `null` for none (#1299).
             *
             * A STRAIGHT PROJECTION of `User.image` — no fallback chain, no
             * existence check, no second query. The issue asked for "the
             * uploaded avatar route if one exists, else `User.image`, else
             * null"; those three cases are already collapsed into this one
             * column by the write path, so walking them here would be a second
             * implementation of a decision `src/lib/account/avatar.ts` has
             * already made:
             *
             *   uploaded  — `uploadOwnAvatar` writes `avatarServeUrl(userId)`,
             *               i.e. `/api/account/avatar/<id>`, INTO `User.image`
             *               (pinned by tests/unit/account-avatar.test.ts);
             *   OAuth     — the PrismaAdapter stores the provider's photo URL
             *               there at first sign-in;
             *   neither   — `removeOwnAvatar` clears it to `null`, and a user
             *               who never had one never had a value.
             *
             * That matters for COST as much as for correctness: `/api/auth/me`
             * is the launch request every client makes, and `image` rides the
             * `findUnique` above. A storage `head` probe per launch to decide
             * between two URLs would buy nothing — the column already says
             * which one it is.
             *
             * RETURNED AS STORED, deliberately: relative for an uploaded
             * avatar, ABSOLUTE and third-party for a provider photo. The
             * clients resolve the two shapes differently (and must not send a
             * bearer to someone else's CDN), so absolutising here would hide
             * which host is about to be contacted. The `avatarUrl` description
             * in `account.paths.ts` is where that contract is written down.
             *
             * Read from the DATABASE rather than from the session, so it is
             * current the moment an upload lands — `session.user.image` comes
             * from the token's `picture` claim, minted at sign-in and stale
             * until the session refreshes.
             */
            avatarUrl: user?.image ?? null,
            // `null` means "no active membership", which is exactly what the
            // adjacent `tenant: null` already says. It must NOT fall back to a
            // real role: READER carries real grants (`view` on evidence/tasks/
            // reports/knowledge plus evidence `download`), so a fallback answers
            // "who am I" with view access for a principal who has none, and a
            // role with no tenant has no referent anyway. The live gates are RLS,
            // `requirePermission` and the middleware tenant check — none read this
            // field — so this is contract honesty, not the authorization boundary.
            role: membership?.role ?? null,
            // Bottom-row arrangement, returned here so a client can draw its
            // tab bar from the launch request it already makes rather than a
            // second round-trip. `null` means "never chosen, use the default";
            // `[]` means deliberately cleared. It is a PREFERENCE — resolve it
            // against the surfaces the member may reach on every render.
            bottomTabOrder: parseBottomTabOrder(user?.bottomTabOrder),
        },
        tenant: membership?.tenant ?? null,
        /**
         * Runtime feature flags, already resolved for this caller.
         *
         * An ABSENT key means OFF. Do not treat a missing key as a default-on:
         * the whole point of the rail is that a surface nobody has enabled is
         * invisible, and the global kill switch (`FEATURE_FLAGS_FORCE_OFF`)
         * answers with an EMPTY OBJECT rather than a set of falses — so
         * "no keys at all" is a legitimate state meaning everything is off.
         *
         * Re-read it; do not cache across sessions. The server caches the table
         * for 30s, which is the propagation bound for a flip.
         */
        featureFlags,
    });
});
