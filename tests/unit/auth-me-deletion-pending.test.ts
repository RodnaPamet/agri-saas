/**
 * `/api/auth/me` reports a pending deletion (P5.6b, #1597).
 *
 * ## Why this field is on THIS route
 *
 * At the native client's request, and for a better reason than the one I
 * proposed. I suggested `/api/account/profile`; `agrent-ios` replied that the
 * phone reads `/api/auth/me` right after every sign-in — before the first
 * screen is shown — and again on every return to the foreground, and that it
 * never reads `/api/account/profile`. So this is the one read guaranteed at the
 * moment the recovery screen needs it.
 *
 * ## The two things that must not drift
 *
 *   - **`erasesAt` must agree with the sweep.** The person is shown a date and
 *     their data goes on a date; two derivations of one deadline is two places
 *     to get it wrong. Both come from `DELETION_GRACE_DAYS`, and this asserts
 *     the arithmetic rather than a literal 30.
 *   - **absent and `null` must mean the same thing.** The client treats them
 *     alike so an older server cannot lock anyone into a recovery screen they
 *     cannot leave, and this pins the server half of that.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const findUnique = jest.fn();
// Both export shapes from one object, and the flag models stubbed: the handler
// also runs `resolveFlags`, which imports the NAMED export and reads
// `featureFlag` / `featureFlagCohortMember`. A mock supplying only `default`
// leaves the client undefined inside the resolver — the precedent is
// `tests/unit/auth-me-role-null.test.ts`, whose docblock records that failure.
jest.mock('@/lib/prisma', () => {
    const client = {
        user: { findUnique: (args: unknown) => findUnique(args) },
        featureFlag: { findMany: jest.fn(async () => []) },
        featureFlagCohortMember: { findMany: jest.fn(async () => []) },
    };
    return { __esModule: true, default: client, prisma: client };
});
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

// SPREAD, not replaced. A whole-module double here omitted `extractErrorMeta`,
// which `withApiErrorHandling`'s error path calls to shape a thrown refusal —
// so the suspension cases died with `extractErrorMeta is not a function`
// instead of asserting a 403. The repo's partial-barrel-mock trap exactly:
// silencing the logger must not remove its siblings.
jest.mock('@/lib/observability/logger', () => ({
    ...jest.requireActual('@/lib/observability/logger'),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/auth/me/route';
import { DELETION_GRACE_DAYS } from '@/app-layer/usecases/account-erasure';

const DAY_MS = 24 * 60 * 60 * 1000;

function userRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'u-1',
        email: 'farmer@example.test',
        name: 'Иван',
        image: null,
        bottomTabOrder: null,
        deletionRequestedAt: null,
        suspendedAt: null,
        tenantMemberships: [],
        ...overrides,
    };
}

/**
 * A REAL `NextRequest`, not a hand-rolled object.
 *
 * `withApiErrorHandling` reads `req.nextUrl.pathname` for the route label, so a
 * plain `{ url, method, headers }` throws `Cannot read properties of undefined
 * (reading 'pathname')` before the handler runs — which is how my first version
 * failed all six. Same factory as `tests/unit/auth-me-role-null.test.ts`.
 */
function req(): NextRequest {
    return new NextRequest('https://app.agrent.bg/api/auth/me', { method: 'GET' });
}

/**
 * Typed loosely but NOT `any`, following `auth-me-role-null.test.ts`: the
 * suspension cases assert `user` is ABSENT, so every field has to be optional
 * or the refusal case cannot be expressed.
 */
type MeBody = {
    user?: {
        id?: string;
        email?: string;
        deletion?: { requestedAt: string; erasesAt: string } | null;
    };
    deletion?: unknown;
    tenant?: unknown;
    featureFlags?: unknown;
    error?: { code?: string; message?: string };
};

async function callMe(): Promise<MeBody> {
    const res = await GET(req(), { params: Promise.resolve({}) });
    return (await res.json()) as MeBody;
}

beforeEach(() => {
    auth.mockReset();
    findUnique.mockReset();
    auth.mockResolvedValue({ user: { id: 'u-1', email: 'farmer@example.test' } });
    findUnique.mockResolvedValue(userRow());
});

describe('no deletion pending', () => {
    it('reports null', async () => {
        const body = await callMe();

        // `null`, not an omitted key: the client treats the two alike, but the
        // server should be definite when it knows.
        expect(body.user?.deletion).toBeNull();
    });
});

describe('a deletion pending', () => {
    it('reports when it was requested and when the data goes', async () => {
        const requestedAt = new Date('2026-10-11T09:00:00.000Z');
        findUnique.mockResolvedValue(userRow({ deletionRequestedAt: requestedAt }));

        const body = await callMe();

        expect(body.user?.deletion?.requestedAt).toBe(requestedAt.toISOString());
        // The arithmetic, not a literal 30: if the grace period ever changes,
        // the date the person is shown changes with the sweep rather than
        // disagreeing with it.
        expect(body.user?.deletion?.erasesAt).toBe(
            new Date(requestedAt.getTime() + DELETION_GRACE_DAYS * DAY_MS).toISOString(),
        );
    });

    it('both timestamps are ISO instants the client can render verbatim', async () => {
        findUnique.mockResolvedValue(
            userRow({ deletionRequestedAt: new Date('2026-10-11T09:00:00.000Z') }),
        );

        const body = await callMe();

        // The phone renders these and derives nothing — so they have to be
        // unambiguous instants, not dates or locale strings.
        for (const v of [body.user?.deletion?.requestedAt, body.user?.deletion?.erasesAt]) {
            expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
    });

    it('erasesAt is AFTER requestedAt by the whole grace period', async () => {
        const requestedAt = new Date('2026-10-11T09:00:00.000Z');
        findUnique.mockResolvedValue(userRow({ deletionRequestedAt: requestedAt }));

        const body = await callMe();

        const gap = new Date(body.user!.deletion!.erasesAt).getTime()
            - new Date(body.user!.deletion!.requestedAt).getTime();
        // Stated as a difference as well as a value, so a sign error or a
        // unit mix-up shows here rather than as a date in the past on a
        // farmer's phone.
        expect(gap).toBe(DELETION_GRACE_DAYS * DAY_MS);
        expect(gap).toBeGreaterThan(0);
    });
});

describe('it does not disturb the rest of the payload', () => {
    it('still returns the fields other clients read', async () => {
        // This route is what every client parses at launch. A field added to
        // it must not change the shape of anything already there — the
        // soft-deleted-farm defect (#1389) was a change to exactly this
        // payload.
        const body = await callMe();

        expect(body.user?.id).toBe('u-1');
        expect(body.user?.email).toBe('farmer@example.test');
        expect(body.user).toHaveProperty('avatarUrl');
        expect(body.user).toHaveProperty('role');
        expect(body.user).toHaveProperty('bottomTabOrder');
        expect(body).toHaveProperty('tenant');
        // `featureFlags`, not `flags` — I guessed the latter and the test
        // told me. Worth pinning by its real name, since this payload is what
        // every client parses at launch.
        expect(body).toHaveProperty('featureFlags');
    });

    it('still refuses an unauthenticated caller', async () => {
        auth.mockResolvedValue(null);

        const res = await GET(req(), { params: Promise.resolve({}) });

        expect(res.status).toBe(401);
    });
});
/**
 * The hole the native client found (#1652).
 *
 * This route authenticates with `auth()`, not `getSessionOrThrow`, so P5.9's
 * suspension check — whose only caller was `getSessionOrThrow` — never ran
 * here. Reported by `agrent-ios` while building the recovery screen, from
 * reading the P5.9 note against the route; I had written that note, and the
 * claim it invites ("a suspended person is told on every request") was false
 * for the ten routes that resolve a session directly.
 *
 * The consequence was specific enough to be worth pinning: `ACCOUNT_TERMINATED`
 * both suspends and starts the erasure, so a terminated person would have
 * signed in, been handed `deletion` by this route, been shown «Възстанови
 * профила», and had the cancel refused — an offer the server would never
 * honour.
 *
 * **Driven off `suspendedAt` on the row, not a mocked `isAccountSuspended`**,
 * because that is how the route reads it. Calling the helper added a second
 * query and reddened `auth-me-avatar-url.test.ts`, which pins this launch
 * request at ONE — correctly, and its docblock predicts that failure in
 * general terms. The column is on the `findUnique` the handler already runs.
 *
 * **The refusal is the ENVELOPE, via the same `codedForbidden` throw
 * `getSessionOrThrow` uses.** My first version returned a bare `{ error:
 * 'ACCOUNT_SUSPENDED' }`, matching this route's own 401 — and the #1228
 * breaking-change gate scored 38 breaking entries against the base, because
 * the bare form REPLACED the documented envelope and `error.code` vanished.
 * Throwing is also the better answer on its own terms: a client needs ONE
 * decoder path for suspension rather than a special case for `/me`.
 */
describe('a suspended account is refused (#1652)', () => {
    it('answers 403 ACCOUNT_SUSPENDED, not 200', async () => {
        findUnique.mockResolvedValue(userRow({ suspendedAt: new Date() }));

        const res = await GET(req(), { params: Promise.resolve({}) });

        expect(res.status).toBe(403);
        // `error.code`, not a bare `error` string — the envelope every other
        // suspension refusal in this API carries.
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('ACCOUNT_SUSPENDED');
    });

    it('does NOT hand a terminated person the `deletion` field', async () => {
        // THE MUTATION TARGET, and the whole defect: a termination suspends AND
        // starts the erasure, so this row is exactly what a terminated account
        // looks like. The recovery screen is driven off `deletion`.
        findUnique.mockResolvedValue(
            userRow({
                suspendedAt: new Date('2026-10-11T08:00:00.000Z'),
                deletionRequestedAt: new Date('2026-10-11T08:00:00.000Z'),
            }),
        );

        const body = await callMe();

        expect(body.user).toBeUndefined();
        expect(body.deletion).toBeUndefined();
    });

    it('refuses with 403 rather than 401, which would send them to sign in again', async () => {
        findUnique.mockResolvedValue(userRow({ suspendedAt: new Date() }));

        const res = await GET(req(), { params: Promise.resolve({}) });

        // 401 reads as "signed out", so the client re-authenticates, succeeds,
        // and is refused again — a loop with no sentence explaining it. Same
        // decision as `getSessionOrThrow`'s.
        //
        // Both halves asserted: `not.toBe(401)` ALONE is satisfied by the 200
        // this whole case exists to prevent, so on its own it would survive
        // deleting the refusal entirely. Measured — the mutation reddened two
        // of three cases here, and this was the one with no teeth.
        expect(res.status).toBe(403);
        expect(res.status).not.toBe(401);
    });

    it('a SELF-requested deletion still gets the field, so recovery stays reachable', async () => {
        // The other side of the ruling, and the distinction the phone needs: a
        // person who asked to leave is NOT suspended, so they keep the field
        // and the recovery screen. Only a terminated account loses it.
        findUnique.mockResolvedValue(
            userRow({
                suspendedAt: null,
                deletionRequestedAt: new Date('2026-10-11T09:00:00.000Z'),
            }),
        );

        const body = await callMe();

        expect(body.user?.deletion?.requestedAt).toBe('2026-10-11T09:00:00.000Z');
    });

    it('costs no extra query — the column rides the findUnique already there', async () => {
        await callMe();

        // The sibling `auth-me-avatar-url.test.ts` owns this property for the
        // whole route; asserted here too because THIS change is what nearly
        // broke it, and the next person adding a per-request check to the
        // launch request should find the reason beside the check.
        expect(findUnique).toHaveBeenCalledTimes(1);
        const select = findUnique.mock.calls[0][0].select;
        expect(select.suspendedAt).toBe(true);
    });
});
