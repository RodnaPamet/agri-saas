/**
 * The OAuth handoff, end to end through the real route handlers.
 *
 * Covers the case the design is most likely to get wrong and least likely to
 * notice: a FIRST-TIME OAuth user. Epic 1 shipped exactly that bug — invite
 * redemption ran in `signIn`, where a first-time user's `user.id` is the
 * identity-provider subject rather than our `User.id`, so it wrote a membership
 * against a non-existent FK and stranded the invitee. The handoff mints a
 * credential at a comparable moment, so "the row exists by now" is asserted
 * rather than assumed.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID, randomBytes } from 'crypto';
import { encode } from 'next-auth/jwt';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { deriveChallenge } from '@/lib/auth/native/auth-codes';
import { GET as complete } from '@/app/api/auth/native/complete/route';
import { POST as exchange } from '@/app/api/auth/native/exchange/route';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SECRET = process.env.AUTH_SECRET ?? 'test-auth-secret-that-is-long-enough-32chars';
const REDIRECT = 'bg.agrent.app://auth/callback';
const ROUTE_CTX = { params: Promise.resolve({}) };

const created: string[] = [];

/** A brand-new user + session — i.e. the state right after a FIRST Google sign-in. */
async function firstTimeUser() {
    const userId = `u-oh-${randomUUID()}`;
    const email = `${userId}@example.test`;
    created.push(userId);
    await db.user.create({ data: { id: userId, email, emailHash: hashForLookup(email) } });
    const sessionRow = await db.userSession.create({
        data: {
            sessionId: `sid-${randomUUID()}`,
            userId,
            tenantId: null,
            expiresAt: new Date(Date.now() + 3600_000),
        },
        select: { id: true, sessionId: true },
    });
    return { userId, email, sessionRow };
}

async function completeReq(u: Awaited<ReturnType<typeof firstTimeUser>>, handoff: unknown) {
    const jwe = await encode({
        token: { userId: u.userId, sub: u.userId, email: u.email, userSessionId: u.sessionRow.sessionId },
        secret: SECRET,
    });
    return new NextRequest('http://localhost/api/auth/native/complete', {
        method: 'GET',
        headers: {
            authorization: `Bearer ${jwe}`,
            cookie: `agrent-native-handoff=${encodeURIComponent(JSON.stringify(handoff))}`,
        },
    });
}

function exchangeReq(body: unknown) {
    return new NextRequest('http://localhost/api/auth/native/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

beforeAll(() => {
    process.env.AUTH_SECRET = SECRET;
    process.env.NATIVE_AUTH_REDIRECT_ALLOWLIST = 'bg.agrent.app://';
});

afterAll(async () => {
    await db.nativeAuthCode.deleteMany({ where: { userId: { in: created } } });
    await db.nativeRefreshToken.deleteMany({ where: { userId: { in: created } } });
    await db.userSession.deleteMany({ where: { userId: { in: created } } });
    await db.user.deleteMany({ where: { id: { in: created } } });
    await db.$disconnect();
});

describeFn('native OAuth handoff', () => {
    it('a FIRST-TIME OAuth user completes the whole handoff', async () => {
        // The Epic 1 case. By the time /complete runs, the adapter has
        // committed the User row and the jwt callback has recorded the session
        // — so both FKs resolve. This asserts that rather than trusting it.
        const u = await firstTimeUser();
        const verifier = randomBytes(32).toString('base64url');

        const res = await complete(
            await completeReq(u, { redirectUri: REDIRECT, codeChallenge: deriveChallenge(verifier) }),
            ROUTE_CTX,
        );
        expect(res.status).toBe(307);

        const location = res.headers.get('location')!;
        expect(location.startsWith(REDIRECT)).toBe(true);

        // ONLY the code travels — never a token.
        //
        // ## This assertion used to fail about once in seven thousand runs
        //
        // It was `expect(location).not.toMatch(/accessToken|refreshToken|eyJ/)`.
        // The `eyJ` arm is a heuristic for "a JWT appears here", and the
        // authorization code is random base64url — so it contains those three
        // characters by chance. Caught in CI on 2026-10-14 with
        // `code=W6W_uwFcok` + `eyJ` + `yXhpAcTeenO5DfTfjVJlQNc8mv84vQ`, which
        // leaked nothing at all. Three characters from a 64-symbol alphabet
        // across ~38 positions is ~1.4e-4 per run, which over a repository's
        // worth of CI is a certainty rather than bad luck.
        //
        // The property is real and worth keeping; what was wrong was aiming a
        // substring scan at a string containing random data. Each assertion
        // below is exact, and none can fire on a random code.
        const url = new URL(location);
        const code = url.searchParams.get('code');
        expect(code).toBeTruthy();

        // 1. The parameter SET, so a token cannot ride along under any name.
        //    An exact set rather than two absences: adding a parameter to an
        //    auth redirect should be a deliberate decision that fails here.
        expect([...url.searchParams.keys()]).toEqual(['code']);

        // 2. The code is not itself a JWT. A JWT is three dot-separated
        //    segments and base64url contains no dot, so this discriminates a
        //    token from a code with NO probability attached — unlike the
        //    `eyJ` prefix, which is 1-in-262144 on a random string.
        expect(code).not.toContain('.');

        const ex = await exchange(exchangeReq({ code, code_verifier: verifier }), ROUTE_CTX);
        expect(ex.status).toBe(200);
        const tokens = await ex.json();
        expect(tokens.tokenType).toBe('Bearer');
        expect(typeof tokens.accessToken).toBe('string');
        expect(typeof tokens.refreshToken).toBe('string');

        // 3. The strongest form of "only the code travelled", and the one the
        //    heuristic was standing in for: the value in the URL is neither
        //    token the exchange hands back. Exact comparison, no pattern, and
        //    it can only be made available AFTER the exchange — which is why
        //    the original assertion reached for a shape test instead.
        expect(code).not.toBe(tokens.accessToken);
        expect(code).not.toBe(tokens.refreshToken);

        // The tokens hang off the SAME session the browser sign-in created,
        // which is what makes them revocable.
        const rows = await db.nativeRefreshToken.findMany({
            where: { userSessionId: u.sessionRow.id },
            select: { id: true },
        });
        expect(rows).toHaveLength(1);
    });

    it('the code is single-use across the REAL routes', async () => {
        const u = await firstTimeUser();
        const verifier = randomBytes(32).toString('base64url');
        const res = await complete(
            await completeReq(u, { redirectUri: REDIRECT, codeChallenge: deriveChallenge(verifier) }),
            ROUTE_CTX,
        );
        const code = new URL(res.headers.get('location')!).searchParams.get('code');

        expect((await exchange(exchangeReq({ code, code_verifier: verifier }), ROUTE_CTX)).status).toBe(200);
        expect((await exchange(exchangeReq({ code, code_verifier: verifier }), ROUTE_CTX)).status).toBe(400);
    });

    it('an exchange WITHOUT the verifier is refused', async () => {
        const u = await firstTimeUser();
        const verifier = randomBytes(32).toString('base64url');
        const res = await complete(
            await completeReq(u, { redirectUri: REDIRECT, codeChallenge: deriveChallenge(verifier) }),
            ROUTE_CTX,
        );
        const code = new URL(res.headers.get('location')!).searchParams.get('code');

        expect((await exchange(exchangeReq({ code }), ROUTE_CTX)).status).toBe(400);
        // …and the real client can still finish, because a bad verifier does
        // not burn the code.
        expect((await exchange(exchangeReq({ code, code_verifier: verifier }), ROUTE_CTX)).status).toBe(200);
    });

    it('a redirect outside the allowlist is refused at /complete', async () => {
        const u = await firstTimeUser();
        const res = await complete(
            await completeReq(u, { redirectUri: 'https://evil.example/steal', codeChallenge: 'x' }),
            ROUTE_CTX,
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('redirect_uri_not_allowed');
    });

    it('every exchange failure returns the SAME shape', async () => {
        const shapes = await Promise.all(
            [
                { code: 'unknown', code_verifier: 'v' },
                { code: '', code_verifier: 'v' },
                {},
            ].map(async (b) => {
                const r = await exchange(exchangeReq(b), ROUTE_CTX);
                return { status: r.status, body: await r.json() };
            }),
        );
        const first = JSON.stringify(shapes[0]);
        for (const s of shapes) expect(JSON.stringify(s)).toBe(first);
    });
});
