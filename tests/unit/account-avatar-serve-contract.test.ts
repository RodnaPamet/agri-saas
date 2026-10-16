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
 *     no-cache` with an `ETag` (#1953 — it was `max-age=300`, which left a
 *     changed avatar stale for five minutes). `private` is the one that
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

const getAvatarObject = jest.fn();
jest.mock('@/lib/account/avatar', () => ({
    getAvatarObject: (userId: string) => getAvatarObject(userId),
}));

/** The shape the route now reads: bytes plus the validator for them. */
const ETAG = '"1f4-18c0a1b2c3d"';
const avatarObject = () => ({
    stream: Readable.from([WEBP_BYTES]),
    etag: ETAG,
});

import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/account/avatar/[userId]/route';

const VIEWER = 'viewer-1';
const SUBJECT = 'subject-2';

const WEBP_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function call(userId: string, headers?: Record<string, string>): Promise<Response> {
    return GET(
        new NextRequest(`https://app.agrent.bg/api/account/avatar/${userId}`, {
            headers,
        }) as never,
        { params: Promise.resolve({ userId }) } as never,
    ) as Promise<Response>;
}

beforeEach(() => {
    jest.clearAllMocks();
    auth.mockReset();
    getAvatarObject.mockReset();
});

describe('GET /api/account/avatar/[userId] — the documented contract (#1299)', () => {
    it('200 streams the stored webp with the documented headers', async () => {
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarObject.mockResolvedValue(avatarObject());

        const res = await call(SUBJECT);

        expect(res.status).toBe(200);
        // Read as a PAIR, because the two headers are one promise to a client:
        // the media type it decodes and how long it may keep it. `private` is
        // not decoration — a shared cache must not hold an authenticated image.
        expect({
            type: res.headers.get('Content-Type'),
            cache: res.headers.get('Cache-Control'),
            etag: res.headers.get('ETag'),
        }).toEqual({
            type: 'image/webp',
            // `no-cache` since #1953, NOT `no-store`: the bytes stay cached
            // and are revalidated, so a changed avatar appears on the next
            // request instead of after `max-age=300` expires.
            cache: 'private, no-cache',
            etag: ETAG,
        });

        // The body really is the stored bytes, not an empty 200.
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(WEBP_BYTES)).toBe(true);
    });

    it('304 for a matching If-None-Match, with no body', async () => {
        // The half that makes `no-cache` cheap. Without it the policy would
        // be a straight bandwidth regression: every render refetching 5–25 KB
        // instead of keeping it for five minutes.
        auth.mockResolvedValue({ user: { id: VIEWER } });
        const object = avatarObject();
        getAvatarObject.mockResolvedValue(object);

        const res = await call(SUBJECT, { 'If-None-Match': ETAG });

        expect(res.status).toBe(304);
        expect(Buffer.from(await res.arrayBuffer()).length).toBe(0);
        // The validator and the policy ride along, or a cache cannot refresh
        // its freshness and would ask again immediately.
        expect(res.headers.get('ETag')).toBe(ETAG);
        expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
        // The stream was opened to answer this request and nothing read it.
        expect(object.stream.destroyed).toBe(true);
    });

    it('200 when If-None-Match does NOT match — the changed avatar', async () => {
        // The case the whole change exists for: a new upload changes the
        // size/mtime validator, so the client's stale tag misses and it gets
        // the new bytes on the very next request rather than in five minutes.
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarObject.mockResolvedValue(avatarObject());

        const res = await call(SUBJECT, { 'If-None-Match': '"something-older"' });

        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(WEBP_BYTES)).toBe(true);
    });

    it('parses the shapes a CACHE sends, not just the one we emit', async () => {
        // A conditional request may carry a LIST, and an intermediary may
        // weaken the tag to `W/"…"`. This route emits neither shape, which is
        // exactly why they are easy to get wrong — a raw string comparison
        // passes every test written against our own output and fails against
        // a real client.
        auth.mockResolvedValue({ user: { id: VIEWER } });

        for (const header of [`W/${ETAG}`, `"other", ${ETAG}`, '*']) {
            getAvatarObject.mockResolvedValue(avatarObject());
            const res = await call(SUBJECT, { 'If-None-Match': header });
            expect(`${header} -> ${res.status}`).toBe(`${header} -> 304`);
        }
    });

    it('404 when the user has no UPLOADED avatar — the ordinary case', async () => {
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarObject.mockResolvedValue(null);

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
        expect(getAvatarObject).not.toHaveBeenCalled();
    });

    it('reads the avatar of the id IN THE PATH, not the caller', async () => {
        // The discriminator for the test below. Were the route to substitute
        // the session user, every assertion about "any user id" would pass
        // while serving the wrong face.
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarObject.mockResolvedValue(avatarObject());

        await call(SUBJECT);

        expect(getAvatarObject).toHaveBeenCalledTimes(1);
        expect(getAvatarObject).toHaveBeenCalledWith(SUBJECT);
        expect(getAvatarObject).not.toHaveBeenCalledWith(VIEWER);
    });

    it('ANY authenticated user may read ANY user id — deliberately not self-only', async () => {
        // Documented behaviour, and the one a later reader is most likely to
        // "fix". Narrowing it to the session user blanks every colleague avatar
        // in every member list and people-picker — the surfaces the route
        // exists for — so it costs a change to this test.
        auth.mockResolvedValue({ user: { id: VIEWER } });
        getAvatarObject.mockResolvedValue(avatarObject());

        const other = await call('a-third-party-user');
        expect(other.status).toBe(200);

        // And the caller's own avatar is not a special case either.
        getAvatarObject.mockResolvedValue(avatarObject());
        const own = await call(VIEWER);
        expect(own.status).toBe(200);
    });
});
