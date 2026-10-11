import { auth } from '@/auth';
import prisma from '@/lib/prisma';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { codedForbidden } from '@/lib/errors/types';
import { parseBottomTabOrder } from '@/lib/account/bottom-tabs';
import { resolveFlags } from '@/lib/feature-flags';
import { DELETION_GRACE_DAYS } from '@/app-layer/usecases/account-erasure';

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
            // P5.6b / agrent-ios — the pending-deletion state, on the query
            // this handler ALREADY runs, so the field costs no extra round
            // trip. See `deletion` in the response for why it lives here
            // rather than on `/api/account/profile`.
            deletionRequestedAt: true,
            // P5.9 / #1652 — likewise on the query this handler ALREADY runs.
            // See the refusal below for why it is read here and not through
            // `isAccountSuspended`.
            suspendedAt: true,
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

    // P5.9's suspension check, which this route was OUTSIDE (#1652).
    //
    // `getSessionOrThrow` is where P5.9 put the check, and all three ctx
    // resolvers reach it — but this route calls `auth()` directly, so it sat
    // outside the only caller `isAccountSuspended` had. Found by the native
    // client while building the deletion-recovery screen, and the consequence
    // was precisely the shape worth fixing: a TERMINATED person — suspended
    // AND erasure-pending — could sign in, get 200 with `deletion` set, be
    // shown «Възстанови профила», and then have the cancel refused with 403.
    // A recovery screen offering an action the server would never honour.
    //
    // **Read off the row above rather than through `isAccountSuspended`**, and
    // that is not a shortcut. This is the LAUNCH request, and
    // `auth-me-avatar-url.test.ts` pins it at ONE query with a docblock
    // predicting that "a later 'let me just check whether the object is really
    // there' would add a query and fail here" — which is exactly what calling
    // the helper did, on a mechanism that docblock did not anticipate. The
    // helper's cache exists to spare a Postgres read on routes that do not
    // already do one; this route must read the `User` row regardless, so the
    // cache saves nothing and the column is authoritative rather than up to
    // 30s stale. It also inherits P5.9's fail-CLOSED direction for free: a
    // request that cannot read this row cannot answer at all.
    //
    // **`codedForbidden`, the SAME throw `getSessionOrThrow` uses**, and that
    // matters more than it looks. Returning a bare `{ error:
    // 'ACCOUNT_SUSPENDED' }` here — which is what this route's own 401 does —
    // would make `/me` the one suspension refusal in the API shaped unlike
    // every other, so a client would need two decoder paths for one condition.
    // The #1228 breaking-change gate caught it: the bare form REPLACED the
    // documented envelope on this route's 403, and it scored 38 breaking
    // entries against the base, led by `error.code` being removed. Throwing
    // leaves the documented contract untouched.
    //
    // 403 and not 401: a suspended person must be told their account is
    // suspended, not that they are signed out, which sends them to a login
    // page that signs them back in and refuses again. No prose rides along —
    // `no-server-authored-user-copy` holds thrown sentences on a downward
    // ratchet and the client renders the code.
    //
    // NINE OTHER ROUTES still resolve a session with a bare `auth()` and
    // remain uncovered — `change-password` and the invite-acceptance pair are
    // the ones that matter. #1652 carries them AND the guard that holds the
    // count at zero, because repeating this block per route is how it gets
    // forgotten on the tenth.
    if (user?.suspendedAt) {
        throw codedForbidden('ACCOUNT_SUSPENDED', 'ACCOUNT_SUSPENDED');
    }

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
            /**
             * A pending account deletion, or `null` (P5.6b, #1597).
             *
             * HERE rather than on `/api/account/profile`, at the native
             * client's request and for a better reason than I had: the phone
             * reads `/api/auth/me` right after every sign-in — before the
             * first screen is shown — and again on every return to the
             * foreground, and it never reads `/api/account/profile`. So this
             * is the one read guaranteed at the moment the recovery screen
             * needs it.
             *
             * `erasesAt` is computed from the SAME constant the sweep uses, so
             * the date a person is shown and the date their data goes cannot
             * disagree. The client renders it and derives nothing.
             *
             * `null` means nothing pending, and an ABSENT key means the same —
             * the client treats them alike, so an older server cannot lock
             * anyone into a recovery screen. The already-erased case needs no
             * field: nobody can sign in to see one.
             */
            deletion: user?.deletionRequestedAt
                ? {
                    requestedAt: user.deletionRequestedAt.toISOString(),
                    erasesAt: new Date(
                        user.deletionRequestedAt.getTime()
                        + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                }
                : null,
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
