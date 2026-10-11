/**
 * A pending-MFA ticket is not a grant.
 *
 * Apple sign-in happens inside the app, so the gate the other providers get
 * at `native/complete` — refuse to issue an auth code while the cookie
 * session owes a factor — has nowhere to stand. The ticket is how the code is
 * collected instead, and its entire safety rests on one property: it must not
 * be redeemable for a session.
 *
 * That property is enforced by a WHERE clause, not by a conditional:
 * `exchangeAuthCode` reads `{ codeHash, purpose: 'SESSION' }`, so a ticket is
 * not found there. These tests exist because a WHERE clause is exactly the
 * kind of thing a later refactor "simplifies" back to a `findUnique` on the
 * unique column, which would silently make every ticket a bearer token.
 *
 * Real database, no mocks: the filter is the thing under test, and a mocked
 * prisma would answer whatever the test told it to.
 */
import { randomUUID, randomBytes } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    issueAuthCode,
    exchangeAuthCode,
    redeemMfaTicket,
    deriveChallenge,
    AUTH_CODE_TTL_SECONDS,
    MFA_TICKET_TTL_SECONDS,
    MAX_MFA_TICKET_ATTEMPTS,
} from '@/lib/auth/native/auth-codes';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const USER_ID = `u-mfat-${randomUUID()}`;
const EMAIL = `${USER_ID}@example.test`;
const REDIRECT = 'bg.agrent.app://auth/callback';

const newVerifier = () => randomBytes(32).toString('base64url');

async function makeSession() {
    return db.userSession.create({
        data: {
            sessionId: `sid-${randomUUID()}`,
            userId: USER_ID,
            tenantId: null,
            expiresAt: new Date(Date.now() + 3_600_000),
        },
        select: { id: true },
    });
}

/**
 * A ticket, or a session code.
 *
 * A ticket gets NO session row, which is the shape the route uses: writing
 * one at ticket time made every 202 enforce `maxConcurrentSessions`.
 */
async function mint(purpose: 'SESSION' | 'PENDING_MFA', verifier: string) {
    const session = purpose === 'SESSION' ? await makeSession() : null;
    const code = await issueAuthCode({
        userSessionRowId: session?.id ?? null,
        userId: USER_ID,
        tenantId: null,
        codeChallenge: deriveChallenge(verifier),
        redirectUri: REDIRECT,
        purpose,
    });
    return { session, code };
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

describeFn('the pending-MFA ticket', () => {
    describe('a ticket cannot be exchanged for a session', () => {
        it('exchangeAuthCode does not find a PENDING_MFA row', async () => {
            const verifier = newVerifier();
            const { code } = await mint('PENDING_MFA', verifier);

            const result = await exchangeAuthCode({
                rawCode: code.raw,
                codeVerifier: verifier,
            });

            // `unknown`, not a dedicated refusal: the row does not match the
            // query, so the exchange never learns a ticket was involved. That
            // keeps the refusal opaque AND means no conditional has to
            // remember to reject it.
            expect(result).toEqual({ ok: false, reason: 'unknown' });
        });

        it('control: a SESSION code with the same shape DOES exchange', async () => {
            // Without this, the test above passes on an exchange that is
            // simply broken, and proves nothing about `purpose`.
            const verifier = newVerifier();
            const { code } = await mint('SESSION', verifier);

            const result = await exchangeAuthCode({
                rawCode: code.raw,
                codeVerifier: verifier,
            });

            expect(result.ok).toBe(true);
        });

        it('the ticket is still UNCONSUMED after the refused exchange', async () => {
            // A refusal must not burn the ticket: the person has not had a
            // chance to type a code yet, and a client that calls the wrong
            // endpoint once should not cost them the sign-in.
            const verifier = newVerifier();
            const { code } = await mint('PENDING_MFA', verifier);
            await exchangeAuthCode({ rawCode: code.raw, codeVerifier: verifier });

            const row = await db.nativeAuthCode.findFirst({
                where: { userId: USER_ID, purpose: 'PENDING_MFA', consumedAt: null },
                orderBy: { createdAt: 'desc' },
            });
            expect(row).not.toBeNull();
        });
    });

    describe('a session code cannot be redeemed as a ticket', () => {
        it('redeemMfaTicket does not find a SESSION row', async () => {
            // The inverse, and it matters as much: if this direction leaked,
            // a browser-handoff code could be spent on the MFA endpoint,
            // which would mint a pair without the factor the ticket exists to
            // collect.
            const verifier = newVerifier();
            const { code } = await mint('SESSION', verifier);

            const result = await redeemMfaTicket({
                rawCode: code.raw,
                codeVerifier: verifier,
                totpCode: '123456',
            });

            expect(result).toEqual({ ok: false, reason: 'ticket_invalid' });
        });
    });

    describe('the ticket binds to its PKCE verifier', () => {
        it('refuses the WRONG verifier without consuming the ticket', async () => {
            const { code } = await mint('PENDING_MFA', newVerifier());

            const result = await redeemMfaTicket({
                rawCode: code.raw,
                codeVerifier: newVerifier(),
                totpCode: '123456',
            });

            expect(result).toEqual({ ok: false, reason: 'ticket_invalid' });
            // Not consumed: a PKCE mismatch is somebody else holding the
            // ticket, and burning it would let them lock the real user out.
            const row = await db.nativeAuthCode.findFirst({
                where: { codeHash: { not: '' }, userId: USER_ID, purpose: 'PENDING_MFA' },
                orderBy: { createdAt: 'desc' },
                select: { consumedAt: true, mfaAttempts: true },
            });
            expect(row?.consumedAt).toBeNull();
            expect(row?.mfaAttempts).toBe(0);
        });
    });

    describe('a malformed code costs nothing', () => {
        it.each(['', '12345', '1234567', 'abcdef', '12 34 56'])(
            'refuses %p as malformed and leaves the attempt count alone',
            async (totpCode) => {
                const verifier = newVerifier();
                const { code } = await mint('PENDING_MFA', verifier);

                const result = await redeemMfaTicket({
                    rawCode: code.raw,
                    codeVerifier: verifier,
                    totpCode,
                });

                expect(result).toEqual({ ok: false, reason: 'code_malformed' });
                const row = await db.nativeAuthCode.findFirst({
                    where: { userId: USER_ID, purpose: 'PENDING_MFA' },
                    orderBy: { createdAt: 'desc' },
                    select: { mfaAttempts: true, consumedAt: true },
                });
                // Spending one of five tries on input that was never a guess
                // would punish a client stutter rather than an attacker.
                expect(row?.mfaAttempts).toBe(0);
                expect(row?.consumedAt).toBeNull();
            },
        );
    });

    describe('the TTLs are not the same number', () => {
        it('a ticket lives five minutes and a session code one', () => {
            // A session code is redeemed by software in a redirect; a ticket
            // waits for a person to open an authenticator. Reusing the 60s
            // would expire the ticket mid-task and look like a flaky sign-in.
            expect(AUTH_CODE_TTL_SECONDS).toBe(60);
            expect(MFA_TICKET_TTL_SECONDS).toBe(300);
        });

        it('the issued row carries the ticket TTL, not the code TTL', async () => {
            const before = Date.now();
            const { code } = await mint('PENDING_MFA', newVerifier());
            const lifetimeSeconds = Math.round((code.expiresAt.getTime() - before) / 1000);
            // Within a second of 300, and nowhere near 60.
            expect(lifetimeSeconds).toBeGreaterThanOrEqual(MFA_TICKET_TTL_SECONDS - 2);
            expect(lifetimeSeconds).toBeLessThanOrEqual(MFA_TICKET_TTL_SECONDS + 2);
        });

        it('a SESSION code still carries the short TTL', async () => {
            const before = Date.now();
            const { code } = await mint('SESSION', newVerifier());
            const lifetimeSeconds = Math.round((code.expiresAt.getTime() - before) / 1000);
            expect(lifetimeSeconds).toBeLessThanOrEqual(AUTH_CODE_TTL_SECONDS + 2);
        });
    });

    describe('an expired ticket is refused', () => {
        it('reports ticket_invalid once past its expiry', async () => {
            const verifier = newVerifier();
            const { code } = await mint('PENDING_MFA', verifier);
            await db.nativeAuthCode.updateMany({
                where: { userId: USER_ID, purpose: 'PENDING_MFA', consumedAt: null },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });

            const result = await redeemMfaTicket({
                rawCode: code.raw,
                codeVerifier: verifier,
                totpCode: '123456',
            });
            expect(result).toEqual({ ok: false, reason: 'ticket_invalid' });
        });
    });

    describe('a ticket writes no session row', () => {
        it('issuing one leaves the user with no new UserSession', async () => {
            // THE regression test for an attacker-reachable eviction.
            //
            // `recordNewSession` enforces `maxConcurrentSessions`. While the
            // session was written at ticket time, somebody holding only a
            // stolen Apple ID — the first factor alone, exactly who the
            // second factor exists to stop — could start Apple sign-in
            // repeatedly and evict the real person's live sessions without
            // ever knowing a code. Abandoned tickets left rows behind too.
            const before = await db.userSession.count({ where: { userId: USER_ID } });

            await mint('PENDING_MFA', newVerifier());

            const after = await db.userSession.count({ where: { userId: USER_ID } });
            expect(after).toBe(before);
        });

        it('the ticket row itself has a NULL session', async () => {
            await mint('PENDING_MFA', newVerifier());
            const row = await db.nativeAuthCode.findFirst({
                where: { userId: USER_ID, purpose: 'PENDING_MFA' },
                orderBy: { createdAt: 'desc' },
                select: { userSessionId: true },
            });
            expect(row?.userSessionId).toBeNull();
        });

        it('control: a SESSION code DOES hang off a session row', async () => {
            // Without this, the two above pass on an `issueAuthCode` that
            // simply never links anything.
            await mint('SESSION', newVerifier());
            const row = await db.nativeAuthCode.findFirst({
                where: { userId: USER_ID, purpose: 'SESSION' },
                orderBy: { createdAt: 'desc' },
                select: { userSessionId: true },
            });
            expect(row?.userSessionId).not.toBeNull();
        });
    });

    it('the attempt cap matches the web challenge', () => {
        // Five either side, so the number of tries does not depend on which
        // device someone happens to be holding.
        expect(MAX_MFA_TICKET_ATTEMPTS).toBe(5);
    });
});
