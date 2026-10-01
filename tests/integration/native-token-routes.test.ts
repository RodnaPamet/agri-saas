/**
 * The native token endpoints, exercised as real route handlers.
 *
 * These call the exported POST handlers directly against a real database, so
 * they prove behaviour rather than shape. The properties under test are the
 * ones that are cheap to claim and expensive to get wrong:
 *
 *   - issue REFUSES when the session cannot be tracked, rather than minting an
 *     unrevocable credential;
 *   - refresh rebuilds claims from the DATABASE, so a refresh cannot keep stale
 *     authority alive;
 *   - every refresh failure is INDISTINGUISHABLE to the caller.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { encode } from 'next-auth/jwt';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { POST as issue } from '@/app/api/auth/token/route';
import { POST as refresh } from '@/app/api/auth/token/refresh/route';
import { POST as revoke } from '@/app/api/auth/native/revoke/route';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/**
 * `withApiErrorHandling` exports the Next-shaped handler, whose second argument
 * types `params` as a PROMISE (the Next 16 async-request-API contract that
 * tests/guards/async-params-route-typing.test.ts enforces). These routes take
 * no path params, so an empty resolved object is the whole context.
 */
const ROUTE_CTX = { params: Promise.resolve({}) };

const SECRET = process.env.AUTH_SECRET ?? 'test-auth-secret-that-is-long-enough-32chars';
const USER_ID = `u-ntr-${randomUUID()}`;
const EMAIL = `${USER_ID}@example.test`;

async function makeSession(overrides: { revokedAt?: Date | null; expiresAt?: Date } = {}) {
    return db.userSession.create({
        data: {
            sessionId: `sid-${randomUUID()}`,
            userId: USER_ID,
            tenantId: null,
            expiresAt: overrides.expiresAt ?? new Date(Date.now() + 3600_000),
            revokedAt: overrides.revokedAt ?? null,
        },
        select: { id: true, sessionId: true },
    });
}

/** A cookie-shaped request carrying real, signed claims. */
async function issueReq(claims: Record<string, unknown>) {
    const jwe = await encode({ token: claims, secret: SECRET });
    return new NextRequest('http://localhost/api/auth/token', {
        method: 'POST',
        headers: { authorization: `Bearer ${jwe}` },
    });
}

function revokeReq(body: unknown) {
    return new NextRequest('http://localhost/api/auth/native/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function refreshReq(body: unknown) {
    return new NextRequest('http://localhost/api/auth/token/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    process.env.AUTH_SECRET = SECRET;
    await db.user.create({
        data: { id: USER_ID, email: EMAIL, emailHash: hashForLookup(EMAIL) },
    });
});

afterAll(async () => {
    await db.nativeRefreshToken.deleteMany({ where: { userId: USER_ID } });
    await db.userSession.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
});

describeFn('POST /api/auth/token', () => {
    it('mints a pair bound to the CURRENT session', async () => {
        const s = await makeSession();
        const res = await issue(await issueReq({
            userId: USER_ID, sub: USER_ID, email: EMAIL, userSessionId: s.sessionId,
        }), ROUTE_CTX);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.tokenType).toBe('Bearer');
        expect(typeof body.accessToken).toBe('string');
        expect(typeof body.refreshToken).toBe('string');

        // Bound to THAT session row — which is what makes it revocable.
        const rows = await db.nativeRefreshToken.findMany({
            where: { userSessionId: s.id },
            select: { id: true },
        });
        expect(rows).toHaveLength(1);
    });

    it('REFUSES rather than minting an unrevocable credential when the session is untracked', async () => {
        // No userSessionId claim => nothing to hang the token from. Issuing
        // anyway would produce exactly the credential this design exists to
        // prevent: one the security UI cannot kill.
        const res = await issue(await issueReq({ userId: USER_ID, sub: USER_ID, email: EMAIL }), ROUTE_CTX);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toBe('session_not_tracked');
    });

    it('refuses a revoked session', async () => {
        const s = await makeSession({ revokedAt: new Date() });
        const res = await issue(await issueReq({
            userId: USER_ID, sub: USER_ID, email: EMAIL, userSessionId: s.sessionId,
        }), ROUTE_CTX);
        expect(res.status).toBe(401);
    });

    it('refuses an unauthenticated caller', async () => {
        const res = await issue(new NextRequest('http://localhost/api/auth/token', { method: 'POST' }), ROUTE_CTX);
        expect(res.status).toBe(401);
    });
});

describeFn('POST /api/auth/token/refresh', () => {
    async function issuedPair() {
        const s = await makeSession();
        const res = await issue(await issueReq({
            userId: USER_ID, sub: USER_ID, email: EMAIL, userSessionId: s.sessionId,
        }), ROUTE_CTX);
        return { session: s, body: await res.json() };
    }

    it('rotates: returns a NEW pair, and the old token dies once its successor is spent', async () => {
        const { body } = await issuedPair();
        const r1 = await refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX);
        expect(r1.status).toBe(200);
        const rotated = await r1.json();
        expect(rotated.refreshToken).not.toBe(body.refreshToken);

        // Re-presenting the old token while its successor is UNSPENT is a
        // retry, not a replay: the client evidently never received the answer.
        // Refusing it here is what signed the owner out mid-field on
        // 2026-09-22 — see `reissueWithinGrace`.
        const retry = await refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX);
        expect(retry.status).toBe(200);

        // That re-issue SPENT the successor, so the same token presented again
        // is theft evidence and the lineage burns.
        const replay = await refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX);
        expect(replay.status).toBe(401);
    });

    it('rebuilds claims from the DATABASE, so a refresh cannot preserve stale authority', async () => {
        // The access token must reflect the user as they are NOW. Proven by
        // decoding it and checking it carries the DB-derived membership shape
        // rather than whatever the caller last held.
        const { body } = await issuedPair();
        const r = await refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX);
        expect(r.status).toBe(200);
        const { accessToken } = await r.json();

        const { decode } = await import('next-auth/jwt');
        const claims = await decode({ token: accessToken, secret: SECRET });
        expect(claims).not.toBeNull();
        // applyMembershipClaims always sets these; a hand-copied claim set
        // would not.
        expect(claims!.memberships).toBeDefined();
        expect(claims!.membershipsTruncated).toBe(false);
        expect(claims!.userId).toBe(USER_ID);
    });

    describe('failures are indistinguishable to the caller', () => {
        // An enumeration oracle here would let an attacker sort real tokens
        // from fake ones, and telling a thief their replay was DETECTED is
        // worse still. Same status, same body, every time.
        it('unknown, malformed, missing and replayed all return the identical response', async () => {
            const { body } = await issuedPair();
            await refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX); // spend it
            // ...and spend its SUCCESSOR too, so re-presenting the parent below
            // is a genuine replay rather than the retry the grace window
            // absorbs. Without this the fourth case returns 200 and the
            // indistinguishability claim is vacuous.
            await refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX);

            const cases = await Promise.all([
                refresh(refreshReq({ refreshToken: 'totally-unknown-token' }), ROUTE_CTX),
                refresh(refreshReq({ refreshToken: '' }), ROUTE_CTX),
                refresh(refreshReq({}), ROUTE_CTX),
                refresh(refreshReq({ refreshToken: body.refreshToken }), ROUTE_CTX), // replay
            ]);

            const shapes = await Promise.all(
                cases.map(async (r) => ({ status: r.status, body: await r.json() })),
            );
            const first = JSON.stringify(shapes[0]);
            for (const s of shapes) expect(JSON.stringify(s)).toBe(first);
        });

        it('a non-JSON body is refused with the same shape', async () => {
            const bad = new NextRequest('http://localhost/api/auth/token/refresh', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: 'not json',
            });
            const r = await refresh(bad, ROUTE_CTX);
            expect(r.status).toBe(401);
            expect((await r.json()).error).toBe('invalid_grant');
        });
    });
});

describeFn('POST /api/auth/native/revoke', () => {
    /** Mint a real pair through the issue route and hand back the refresh token. */
    async function mintFor(sessionId: string): Promise<string> {
        const res = await issue(await issueReq({
            userId: USER_ID, sub: USER_ID, email: EMAIL, userSessionId: sessionId,
        }), ROUTE_CTX);
        expect(res.status).toBe(200);
        return (await res.json()).refreshToken as string;
    }

    it('revokes the session AND its tokens, so a later refresh is refused', async () => {
        const s = await makeSession();
        const token = await mintFor(s.sessionId);

        expect((await revoke(revokeReq({ refreshToken: token }), ROUTE_CTX)).status).toBe(200);

        // The session is the load-bearing half: rotateRefreshToken re-reads
        // session.revokedAt and fails closed, so even a token that escaped the
        // sweep cannot mint anything.
        const session = await db.userSession.findUnique({
            where: { id: s.id }, select: { revokedAt: true, revokedReason: true },
        });
        expect(session?.revokedAt).not.toBeNull();
        expect(session?.revokedReason).toBe('native_sign_out');

        const live = await db.nativeRefreshToken.count({
            where: { userSessionId: s.id, revokedAt: null },
        });
        expect(live).toBe(0);

        // The property that matters to a client: the credential is dead.
        const after = await refresh(refreshReq({ refreshToken: token }), ROUTE_CTX);
        expect(after.status).toBe(401);
        expect((await after.json()).error).toBe('invalid_grant');
    });

    it('leaves OTHER sessions of the same user alone — scope is one device', async () => {
        const keep = await makeSession();
        const kill = await makeSession();
        const keepToken = await mintFor(keep.sessionId);
        const killToken = await mintFor(kill.sessionId);

        await revoke(revokeReq({ refreshToken: killToken }), ROUTE_CTX);

        const other = await db.userSession.findUnique({
            where: { id: keep.id }, select: { revokedAt: true },
        });
        expect(other?.revokedAt).toBeNull();
        // And it still works, which is the user-visible half of "stays signed in".
        expect((await refresh(refreshReq({ refreshToken: keepToken }), ROUTE_CTX)).status).toBe(200);
    });

    it('answers an UNKNOWN token identically to a revoked one — no oracle', async () => {
        // RFC 7009. If these differed, anyone holding a candidate token could ask
        // whether it exists.
        const s = await makeSession();
        const token = await mintFor(s.sessionId);
        const first = await revoke(revokeReq({ refreshToken: token }), ROUTE_CTX);
        const unknown = await revoke(revokeReq({ refreshToken: 'never-issued-at-all' }), ROUTE_CTX);

        expect(unknown.status).toBe(first.status);
        expect(await unknown.text()).toBe(await first.text());
    });

    it('is IDEMPOTENT — a retried sign-out is not an error', async () => {
        const s = await makeSession();
        const token = await mintFor(s.sessionId);
        const a = await revoke(revokeReq({ refreshToken: token }), ROUTE_CTX);
        const b = await revoke(revokeReq({ refreshToken: token }), ROUTE_CTX);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(await b.text()).toBe(await a.text());
    });

    it('400s a malformed body — the caller\'s own bug, not a claim about a token', async () => {
        expect((await revoke(revokeReq({}), ROUTE_CTX)).status).toBe(400);
        expect((await revoke(revokeReq({ refreshToken: '' }), ROUTE_CTX)).status).toBe(400);
        expect((await revoke(revokeReq({ refreshToken: 42 }), ROUTE_CTX)).status).toBe(400);
    });
});
