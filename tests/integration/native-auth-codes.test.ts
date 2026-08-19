/**
 * The OAuth handoff's authorization code — single use, PKCE-bound, short-lived.
 *
 * Executing tests against a real database, because every property here is
 * behavioural and each failure mode is silent:
 *
 *   - a code that can be spent twice mints two sessions from one authorization;
 *   - a code that exchanges without the verifier makes PKCE decorative, and an
 *     intercepted redirect becomes a session;
 *   - a code that outlives its redirect is recoverable from browser history.
 *
 * None of those show up as an error anywhere. They show up as an account
 * someone else is using.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID, randomBytes } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    issueAuthCode,
    exchangeAuthCode,
    deriveChallenge,
    isAllowedRedirect,
    AUTH_CODE_TTL_SECONDS,
} from '@/lib/auth/native/auth-codes';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const USER_ID = `u-nac-${randomUUID()}`;
const EMAIL = `${USER_ID}@example.test`;
const REDIRECT = 'bg.agrent.app://auth/callback';

function newVerifier() {
    return randomBytes(32).toString('base64url');
}

async function makeSession(overrides: { revokedAt?: Date | null } = {}) {
    return db.userSession.create({
        data: {
            sessionId: `sid-${randomUUID()}`,
            userId: USER_ID,
            tenantId: null,
            expiresAt: new Date(Date.now() + 3600_000),
            revokedAt: overrides.revokedAt ?? null,
        },
        select: { id: true },
    });
}

async function mint(verifier: string, sessionRowId?: string) {
    const s = sessionRowId ? { id: sessionRowId } : await makeSession();
    const code = await issueAuthCode({
        userSessionRowId: s.id,
        userId: USER_ID,
        tenantId: null,
        codeChallenge: deriveChallenge(verifier),
        redirectUri: REDIRECT,
    });
    return { session: s, code };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await db.user.create({
        data: { id: USER_ID, email: EMAIL, emailHash: hashForLookup(EMAIL) },
    });
});

afterAll(async () => {
    await db.nativeAuthCode.deleteMany({ where: { userId: USER_ID } });
    await db.userSession.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
});

describeFn('native authorization code', () => {
    describe('the code is SINGLE USE', () => {
        it('exchanges once and refuses the replay', async () => {
            const v = newVerifier();
            const { code } = await mint(v);

            const first = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: v });
            expect(first.ok).toBe(true);

            const replay = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: v });
            expect(replay.ok).toBe(false);
            if (!replay.ok) expect(replay.reason).toBe('consumed');
        });

        it('a CONCURRENT double-exchange leaves exactly ONE winner', async () => {
            // The atomic-claim proof. A read-then-write implementation passes
            // the sequential test above and fails this one — and the
            // consequence is two token families from one authorization.
            const v = newVerifier();
            const { code } = await mint(v);

            const [a, b] = await Promise.all([
                exchangeAuthCode({ rawCode: code.raw, codeVerifier: v }),
                exchangeAuthCode({ rawCode: code.raw, codeVerifier: v }),
            ]);
            expect([a, b].filter((r) => r.ok)).toHaveLength(1);
        });

        it('the row records consumption, so a family is reconstructable after the fact', async () => {
            const v = newVerifier();
            const { code } = await mint(v);
            await exchangeAuthCode({ rawCode: code.raw, codeVerifier: v });

            const row = await db.nativeAuthCode.findFirst({
                where: { userId: USER_ID },
                orderBy: { createdAt: 'desc' },
                select: { consumedAt: true },
            });
            expect(row!.consumedAt).not.toBeNull();
        });
    });

    describe('PKCE binds the exchange', () => {
        it('refuses an exchange with the WRONG verifier', async () => {
            const { code } = await mint(newVerifier());
            const res = await exchangeAuthCode({
                rawCode: code.raw,
                codeVerifier: newVerifier(),
            });
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('pkce_mismatch');
        });

        it('refuses an exchange with NO verifier', async () => {
            const { code } = await mint(newVerifier());
            const res = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: '' });
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('pkce_mismatch');
        });

        it('a WRONG verifier does NOT burn the code — the real client can still finish', async () => {
            // If a failed PKCE check consumed the code, one guess from an
            // interceptor would lock out the legitimate client. The attacker
            // could not use the code either, but denial of sign-in is still a
            // successful attack.
            const v = newVerifier();
            const { code } = await mint(v);

            const wrong = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: newVerifier() });
            expect(wrong.ok).toBe(false);

            const right = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: v });
            expect(right.ok).toBe(true);
        });
    });

    describe('codes expire', () => {
        it('is refused once past expiresAt', async () => {
            const v = newVerifier();
            const { code } = await mint(v);

            // Age it past the TTL rather than sleeping for it.
            await db.nativeAuthCode.updateMany({
                where: { userId: USER_ID, consumedAt: null },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });

            const res = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: v });
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('expired');
        });

        it('the TTL is measured in SECONDS — it rides a redirect the OS may log', () => {
            expect(AUTH_CODE_TTL_SECONDS).toBeLessThanOrEqual(120);
        });
    });

    describe('the session remains the authority', () => {
        it('a revoked session refuses the exchange', async () => {
            const v = newVerifier();
            const s = await makeSession();
            const { code } = await mint(v, s.id);
            await db.userSession.update({
                where: { id: s.id },
                data: { revokedAt: new Date(), revokedReason: 'admin:test' },
            });
            const res = await exchangeAuthCode({ rawCode: code.raw, codeVerifier: v });
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('session_invalid');
        });
    });

    describe('unknown codes', () => {
        it('an unknown code is refused', async () => {
            const res = await exchangeAuthCode({ rawCode: 'nope', codeVerifier: newVerifier() });
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('unknown');
        });
    });

    describe('redirect allowlist — this must never become an open redirect', () => {
        it('refuses EVERYTHING when the allowlist is empty', () => {
            // Fail closed. An unconfigured allowlist that allowed everything
            // would turn the start endpoint into an open redirect that also
            // carries an authorization code.
            expect(isAllowedRedirect(REDIRECT, [])).toBe(false);
        });

        it('allows only a configured prefix', () => {
            expect(isAllowedRedirect(REDIRECT, ['bg.agrent.app://'])).toBe(true);
            expect(isAllowedRedirect('https://evil.example/steal', ['bg.agrent.app://'])).toBe(false);
        });

        it('an empty-string entry does not match everything', () => {
            // `''` is a prefix of every string; a sloppy startsWith would make
            // one blank config line open the gate completely.
            expect(isAllowedRedirect('https://evil.example', [''])).toBe(false);
        });
    });
});
