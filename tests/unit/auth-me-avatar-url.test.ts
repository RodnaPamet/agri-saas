/**
 * `/api/auth/me` returns the caller's avatar, AS STORED — asserted on the
 * RESPONSE (#1299).
 *
 * ## What is actually at risk here
 *
 * The field is a one-line projection of `User.image`, so the thing worth
 * testing is not "does a value appear" but the two properties the contract in
 * `account.paths.ts` promises a client, neither of which a reader can confirm
 * from the handler alone:
 *
 *   1. **BOTH shapes survive.** An uploaded avatar is a root-relative path
 *      (`/api/account/avatar/<id>`); an OAuth provider photo is an absolute
 *      third-party URL. The issue (agrent-ios#149) is precisely that the
 *      second kind was invisible to a client, so a test that only exercises
 *      the first proves the half that already worked.
 *   2. **Nothing is rewritten.** The server deliberately does NOT absolutise
 *      the relative form or relativise the absolute one — a client resolves a
 *      relative value against the API base and sends its bearer, and must do
 *      neither to a provider URL. An "improvement" that normalised the two
 *      into one shape would look tidy, break the provider case (a 404 against
 *      our base) and, in the other direction, send the bearer token to
 *      Google's CDN. Asserted with `toBe` on the exact string, and with an
 *      explicit "did not gain an origin" assertion so the failure NAMES the
 *      rewrite rather than printing two similar URLs.
 *
 * ## The third property: it costs nothing
 *
 * `/api/auth/me` is the launch request. The issue suggested a fallback chain
 * ("the uploaded avatar route if one exists, else `User.image`"), which reads
 * as a storage existence probe per launch. It is unnecessary because
 * `uploadOwnAvatar` already writes the serve URL INTO `User.image`, so the
 * answer rides the `findUnique` the handler already runs. That is asserted as
 * a CALL COUNT plus the select's own shape — a later "let me just check
 * whether the object is really there" would add a query and fail here.
 *
 * ## Why this does not re-test the write path
 *
 * The premise above belongs to `tests/unit/account-avatar.test.ts`, which pins
 * `uploadOwnAvatar` → `{ image: '/api/account/avatar/u1' }` and
 * `removeOwnAvatar` → `{ image: null }`. This file imports `avatarServeUrl`
 * from that same module rather than hard-coding the path, so a change to the
 * serve-URL shape reddens the projection test too instead of leaving the two
 * halves agreeing with different strings.
 *
 * Mock shape (prisma default + named, redis null, flags via real
 * `resolveFlags`) is inherited from `auth-me-feature-flags.test.ts` and
 * `auth-me-role-null.test.ts` — see the latter for why a partial prisma mock
 * makes this route throw inside the flag resolver.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const findUnique = jest.fn();
jest.mock('@/lib/prisma', () => {
    const client = {
        // Args are CAPTURED, not discarded: one assertion below is about the
        // `select` this handler asks for, which is how "no extra query" is
        // shown to be true by construction rather than by a count alone.
        user: { findUnique: (args: unknown) => findUnique(args) },
        featureFlag: { findMany: jest.fn(async () => []) },
        featureFlagCohortMember: { findMany: jest.fn(async () => []) },
    };
    return { __esModule: true, default: client, prisma: client };
});
jest.mock('@/lib/redis', () => ({ getRedis: () => null }));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/auth/me/route';
import { avatarServeUrl } from '@/lib/account/avatar';

const USER_ID = 'user-1299';
const ROUTE_CTX = { params: Promise.resolve({}) } as never;

/** A real Google profile-photo URL shape — absolute, third-party, sized. */
const GOOGLE_PHOTO =
    'https://lh3.googleusercontent.com/a/ACg8ocK-ZbxQ7m1Rr0N6example=s96-c';

interface MeUser {
    id?: string;
    name?: string | null;
    avatarUrl?: string | null;
}

async function callMe(image: string | null): Promise<MeUser> {
    auth.mockResolvedValue({ user: { id: USER_ID } });
    findUnique.mockResolvedValue({
        id: USER_ID,
        email: 'operator@example.test',
        name: 'Operator',
        image,
        bottomTabOrder: null,
        tenantMemberships: [],
    });
    // NextRequest, not Request: `withApiErrorHandling` reads
    // `req.nextUrl.pathname` for its request-id logging.
    const res = await GET(
        new NextRequest('https://app.agrent.bg/api/auth/me') as never,
        ROUTE_CTX,
    );
    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as { user: MeUser };
    return body.user;
}

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockReset();
    findUnique.mockReset();
});

/**
 * The three states of `User.image`, driven from ONE table.
 *
 * The rows are the discriminator for each other: a handler that answered
 * `null` unconditionally, or echoed one constant, passes any single row and
 * fails the set. `expected` is written as a function of the stored value on
 * purpose — the contract is "as stored", so restating the expectation as a
 * fresh literal would let a transform that happens to produce the literal
 * pass.
 */
const CASES: Array<{ name: string; stored: string | null }> = [
    { name: 'an UPLOADED avatar (relative serve path)', stored: avatarServeUrl(USER_ID) },
    { name: 'an OAUTH provider photo (absolute third-party URL)', stored: GOOGLE_PHOTO },
    { name: 'NO avatar', stored: null },
];

describe('GET /api/auth/me — avatarUrl projects User.image verbatim (#1299)', () => {
    it.each(CASES)('$name reaches the wire unchanged', async ({ stored }) => {
        const user = await callMe(stored);
        expect(user.avatarUrl).toBe(stored);
    });

    it('the key is PRESENT even with no avatar — null, never absent', async () => {
        // The spec marks the field optional so a client can decode an older
        // server's response, which makes "absent" a legitimate shape on the
        // WIRE. It is not a legitimate shape from THIS server: absent would be
        // indistinguishable from a handler that stopped emitting the field.
        const user = await callMe(null);
        expect(Object.hasOwn(user, 'avatarUrl')).toBe(true);
        expect(user.avatarUrl).toBeNull();
    });

    it('an UPLOADED avatar stays RELATIVE — it never gains an origin', async () => {
        const stored = avatarServeUrl(USER_ID);
        const user = await callMe(stored);

        // The failure this names: absolutising against the API base. A client
        // that resolves the value itself then gets a double-prefixed URL, and
        // the iOS session's branch-on-`/` test stops working.
        expect(user.avatarUrl).toBe(stored);
        expect(user.avatarUrl?.startsWith('/')).toBe(true);
        expect(user.avatarUrl).not.toMatch(/^https?:\/\//);
        // And it is the SAME path the upload side writes — asserted through
        // the helper, so a change to the serve-URL shape fails here too.
        expect(user.avatarUrl).toBe(`/api/account/avatar/${USER_ID}`);
    });

    it('an OAUTH photo stays ABSOLUTE and third-party — it is never relativised', async () => {
        const user = await callMe(GOOGLE_PHOTO);

        // The mirror failure, and the expensive one: a client that treats this
        // as same-origin attaches its bearer token and leaks it to the CDN.
        expect(user.avatarUrl).toBe(GOOGLE_PHOTO);
        expect(new URL(user.avatarUrl as string).host).toBe('lh3.googleusercontent.com');
        expect(user.avatarUrl?.startsWith('/')).toBe(false);
    });

    it('the three cases produce three DIFFERENT answers', async () => {
        // The differential control. Every assertion above is satisfied by a
        // handler that echoes its input, and that is exactly what is wanted —
        // but it is ALSO satisfied, one at a time, by a constant. Reading the
        // three together is what rules that out.
        const answers = [];
        for (const { stored } of CASES) answers.push(await callMe(stored));
        expect(answers.map((u) => u.avatarUrl)).toEqual([
            avatarServeUrl(USER_ID),
            GOOGLE_PHOTO,
            null,
        ]);
        expect(new Set(answers.map((u) => u.avatarUrl)).size).toBe(3);
    });

    it('costs NO extra query and NO existence probe', async () => {
        await callMe(avatarServeUrl(USER_ID));

        // One user read for the whole launch request. A fallback chain that
        // probed storage, or a second `findUnique` for the image, fails here.
        expect(findUnique).toHaveBeenCalledTimes(1);

        // And the value comes from THAT read: `image` is in its select. Without
        // this the count alone would also pass for a handler that fetched the
        // avatar some other way entirely.
        const select = (findUnique.mock.calls[0][0] as { select: Record<string, unknown> })
            .select;
        expect(select.image).toBe(true);
    });

    it('CONTROL: the other fields still answer, so this is additive', async () => {
        const user = await callMe(GOOGLE_PHOTO);
        expect({ id: user.id, name: user.name }).toEqual({
            id: USER_ID,
            name: 'Operator',
        });
    });
});
