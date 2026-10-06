/**
 * `GET /api/account/avatar/[userId]` — the contract #1299 wrote down, EXECUTED.
 *
 * This route has been live since the avatar roadmap P3 and was undescribed
 * until #1299 removed it from `tests/guards/openapi-undocumented-baseline.json`
 * and documented it in `account.paths.ts`. Clients had been reading its shape
 * out of route code (agrent-ios#149).
 *
 * Documenting it makes four CLAIMS a client will now rely on, and none of them
 * was executed by anything before this file. `tests/unit/account-avatar.test.ts`
 * covers `getAvatarStream` — the lib — and `avatar-renderer-convergence.test.ts`
 * matches this route's SOURCE TEXT, which cannot see a status code or a header.
 * So:
 *
 *   - 200 carries `Content-Type: image/webp` and `Cache-Control: private,
 *     max-age=300`. Both are in the spec now, and `private` is the one that
 *     matters: avatars sit behind auth, so a shared cache storing one is a
 *     cross-user leak. `Cache-Control` is also a literal this repo has broken
 *     before: a project-wide entity rename mangled 39 of these header names and
 *     the whole suite stayed green, because a header name is a STRING and
 *     TypeScript has nothing to say about it. That is why
 *     `tests/guards/web-platform-identifiers.test.ts` exists — and it will
 *     reject this very file if the mangled spelling is written out here, which
 *     is why the sentence above does not quote it.
 *   - 404 is the ORDINARY answer, not an error: it is what every user without
 *     an UPLOADED avatar returns, including every user whose photo came from
 *     an OAuth provider. The spec says so because a client that logs it as a
 *     failure will log it for most of its users.
 *   - 401 when there is no session.
 *   - ANY authenticated user may read ANY user id. That is deliberate (member
 *     lists and people-pickers render colleagues' faces), and it is the claim
 *     most likely to be "tightened" by a later reader who reads the route as a
 *     self-service endpoint like its `/api/account/avatar` sibling. Asserted,
 *     so narrowing it costs a visible test change rather than silently blanking
 *     every avatar in the app.
 *
 * `@/lib/account/avatar` is mocked rather than the storage provider: the
 * resolution of a key to a stream is that module's own tested business, and
 * `@/lib/storage` vs `@/lib/storage/index` is a mocking trap this repo has
 * already paid for (see `tests/guards/storage-module-specifier.test.ts`). The
 * mock is asserted CALLED, and with WHICH id, for the same reason.
 */
const auth = jest.fn();
jest.mock('@/auth', () => ({ auth: () => auth() }));

const getAvatarStream = jest.fn();
jest.mock('@/lib/account/avatar', () => ({
    getAvatarStream: (userId: string) => getAvatarStream(userId),
}));

import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/account/avatar/[userId]/route';

const VIEWER = 'viewer-1';
const SUBJECT = 'subject-2';

const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function call(userId: string): Promise<Response> {
    return GET(
        new NextRequest(`https://app.agrent.bg/api/account/avatar/${userId}`) as never,
        { params: Promise.resolve({ userId }) } as never,
    ) as Promise<Response>;
}

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockReset();
    getAvatarStream.mockReset();
});

describe('GET /api/account/avatar/[userId] — the documented contract (#1299)', () => {
    it('200 streams the stored webp with the documented headers', async () => {
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarStream.mockResolvedValue(Readable.from([WEBP_BYTES]));

        const res = await call(SUBJECT);

        expect(res.status).toBe(200);
        // Read as a PAIR, because the two headers are one promise to a client:
        // the media type it decodes and how long it may keep it. `private` is
        // not decoration — a shared cache must not hold an authenticated image.
        expect({
            type: res.headers.get('Content-Type'),
            cache: res.headers.get('Cache-Control'),
        }).toEqual({ type: 'image/webp', cache: 'private, max-age=300' });

        // The body really is the stored bytes, not an empty 200.
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(WEBP_BYTES)).toBe(true);
    });

    it('404 when the user has no UPLOADED avatar — the ordinary case', async () => {
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarStream.mockResolvedValue(null);

        const res = await call(SUBJECT);

        expect(res.status).toBe(404);
        // JSON, from the shared error envelope — an `<img>` treats it as a load
        // failure and `<InitialsAvatar>` falls back to initials. A client that
        // expects image bytes on every 2xx-or-not must not be handed webp here.
        expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    });

    it('401 with no session — and the storage layer is never consulted', async () => {
        auth.mockResolvedValue(null);

        const res = await call(SUBJECT);

        expect(res.status).toBe(401);
        // The order matters: an unauthenticated caller must not be able to make
        // the server do a storage lookup. Without this the 401 could be
        // returned AFTER the probe and read identically.
        expect(getAvatarStream).not.toHaveBeenCalled();
    });

    it('reads the avatar of the id IN THE PATH, not the caller', async () => {
        // The discriminator for the test below. Were the route to substitute
        // the session user, every assertion about "any user id" would pass
        // while serving the wrong face.
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarStream.mockResolvedValue(Readable.from([WEBP_BYTES]));

        await call(SUBJECT);

        expect(getAvatarStream).toHaveBeenCalledTimes(1);
        expect(getAvatarStream).toHaveBeenCalledWith(SUBJECT);
        expect(getAvatarStream).not.toHaveBeenCalledWith(VIEWER);
    });

    it('ANY authenticated user may read ANY user id — deliberately not self-only', async () => {
        // Documented behaviour, and the one a later reader is most likely to
        // "fix". Narrowing it to the session user blanks every colleague avatar
        // in every member list and people-picker — the surfaces the route
        // exists for — so it costs a change to this test.
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarStream.mockResolvedValue(Readable.from([WEBP_BYTES]));

        const other = await call('a-third-party-user');
        expect(other.status).toBe(200);

        // And the caller's own avatar is not a special case either.
        getAvatarStream.mockResolvedValue(Readable.from([WEBP_BYTES]));
        const own = await call(VIEWER);
        expect(own.status).toBe(200);
    });
});
