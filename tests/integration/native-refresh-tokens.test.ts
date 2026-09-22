/**
 * Native bearer tokens — the revocation-parity and rotation proofs.
 *
 * These are EXECUTING tests against a real database, deliberately, because the
 * property under test is behavioural and the failure mode this whole design
 * guards against is a credential that outlives the security UI meant to kill
 * it. A structural test asserting "the code calls revokeFamily" would pass
 * while the token still worked — which is exactly how session revocation came
 * to be inert in the first place (see the 2026-08-18 enforcement note).
 *
 * Each test states the lever it exercises, because the point is not that the
 * service works in the abstract but that EVERY existing revocation lever
 * reaches a token without any token-specific bookkeeping.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    issueRefreshToken,
    rotateRefreshToken,
    revokeTokensForSession,
    hashToken,
    REFRESH_REPLAY_GRACE_SECONDS,
} from '@/lib/auth/native/refresh-tokens';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const USER_ID = `u-nrt-${randomUUID()}`;
const TENANT_ID = `t-nrt-${randomUUID()}`;

async function makeSession(overrides: { expiresAt?: Date; revokedAt?: Date | null } = {}) {
    return db.userSession.create({
        data: {
            sessionId: `sid-${randomUUID()}`,
            userId: USER_ID,
            tenantId: TENANT_ID,
            expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
            revokedAt: overrides.revokedAt ?? null,
        },
        select: { id: true, expiresAt: true },
    });
}

async function issueFor(session: { id: string; expiresAt: Date }) {
    return issueRefreshToken({
        userSessionRowId: session.id,
        userId: USER_ID,
        tenantId: TENANT_ID,
        sessionExpiresAt: session.expiresAt,
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    // UserSession.userId is a real FK, so the fixture needs a real User.
    // The raw client bypasses the PII middleware, so emailHash is supplied
    // explicitly — exactly as tests/integration/user-session-rls.test.ts does.
    const email = `${USER_ID}@example.test`;
    await db.user.create({
        data: { id: USER_ID, email, emailHash: hashForLookup(email) },
    });
});

afterAll(async () => {
    await db.nativeRefreshToken.deleteMany({ where: { userId: USER_ID } });
    await db.userSession.deleteMany({ where: { userId: USER_ID } });
    await db.user.deleteMany({ where: { id: USER_ID } });
    await db.$disconnect();
});

describeFn('native refresh tokens', () => {
    describe('the raw token is never recoverable from the database', () => {
        it('stores only the SHA-256', async () => {
            const s = await makeSession();
            const { raw } = await issueFor(s);
            const row = await db.nativeRefreshToken.findUnique({
                where: { tokenHash: hashToken(raw) },
                select: { tokenHash: true },
            });
            expect(row).not.toBeNull();
            expect(row!.tokenHash).not.toBe(raw);
            // And the raw value appears nowhere in the row.
            const all = await db.nativeRefreshToken.findMany({ where: { userId: USER_ID } });
            expect(JSON.stringify(all)).not.toContain(raw);
        });
    });

    describe('rotation', () => {
        it('spending a token returns a NEW one and marks the old consumed', async () => {
            const s = await makeSession();
            const first = await issueFor(s);

            const res = await rotateRefreshToken(first.raw);
            expect(res.ok).toBe(true);
            if (!res.ok) return;
            expect(res.raw).not.toBe(first.raw);

            const old = await db.nativeRefreshToken.findUnique({
                where: { tokenHash: hashToken(first.raw) },
                select: { consumedAt: true, replacedById: true },
            });
            expect(old!.consumedAt).not.toBeNull();
            // The audit trail that makes a family reconstructable.
            expect(old!.replacedById).not.toBeNull();
        });

        it('the successor stays in the SAME family', async () => {
            const s = await makeSession();
            const first = await issueFor(s);
            const res = await rotateRefreshToken(first.raw);
            if (!res.ok) throw new Error('expected rotation to succeed');

            const rows = await db.nativeRefreshToken.findMany({
                where: { userSessionId: s.id },
                select: { familyId: true },
            });
            expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
        });
    });

    describe('replay: a lost answer is absorbed, theft still burns', () => {
        it('a re-presented token is HONOURED while its successor is unspent', async () => {
            // The production defect, 2026-09-22: the owner's session was killed
            // 1.02s after a LEGITIMATE rotation because the app asked twice. An
            // unspent successor is the evidence that the first answer never
            // landed, so this must not be read as theft.
            const s = await makeSession();
            const first = await issueFor(s);
            const second = await rotateRefreshToken(first.raw);
            if (!second.ok) throw new Error('setup: first rotation should succeed');

            const retry = await rotateRefreshToken(first.raw);
            expect(retry.ok).toBe(true);
            if (!retry.ok) return;
            expect(retry.raw).not.toBe(first.raw);
            expect(retry.raw).not.toBe(second.raw);

            // The session is untouched, which is the entire point: the
            // operator is still signed in.
            const session = await db.userSession.findUnique({
                where: { id: s.id },
                select: { revokedAt: true },
            });
            expect(session!.revokedAt).toBeNull();

            // And what the client just received actually works.
            expect((await rotateRefreshToken(retry.raw)).ok).toBe(true);
        });

        it('once the successor has been SPENT, replaying its parent burns the lineage + session', async () => {
            // Unchanged contract, and the reason the grace above is safe: a
            // client that spent the successor demonstrably RECEIVED it, so a
            // later presentation of its parent is theft evidence.
            const s = await makeSession();
            const first = await issueFor(s);
            const second = await rotateRefreshToken(first.raw);
            if (!second.ok) throw new Error('setup: first rotation should succeed');
            const third = await rotateRefreshToken(second.raw);
            if (!third.ok) throw new Error('setup: second rotation should succeed');

            const replay = await rotateRefreshToken(first.raw);
            expect(replay.ok).toBe(false);
            if (replay.ok) return;
            expect(replay.reason).toBe('replayed');

            // The token the LEGITIMATE client holds is dead too. Deliberate:
            // once the lineage forks, thief and victim are indistinguishable,
            // so both are signed out rather than left sharing a session.
            expect((await rotateRefreshToken(third.raw)).ok).toBe(false);

            const session = await db.userSession.findUnique({
                where: { id: s.id },
                select: { revokedAt: true, revokedReason: true },
            });
            expect(session!.revokedAt).not.toBeNull();
            expect(session!.revokedReason).toBe('security:refresh-replayed');
        });

        it('past the grace window a replay burns, even with the successor unspent', async () => {
            // The bound. An unspent successor is ALSO the normal state between
            // refreshes, so without a window a spent token would stay usable
            // for as long as a quiet client sat on an unused one.
            const s = await makeSession();
            const first = await issueFor(s);
            const second = await rotateRefreshToken(first.raw);
            if (!second.ok) throw new Error('setup: first rotation should succeed');

            await db.nativeRefreshToken.update({
                where: { tokenHash: hashToken(first.raw) },
                data: {
                    consumedAt: new Date(Date.now() - (REFRESH_REPLAY_GRACE_SECONDS + 1) * 1000),
                },
            });

            const replay = await rotateRefreshToken(first.raw);
            expect(replay.ok).toBe(false);
            if (!replay.ok) expect(replay.reason).toBe('replayed');

            const session = await db.userSession.findUnique({
                where: { id: s.id },
                select: { revokedReason: true },
            });
            expect(session!.revokedReason).toBe('security:refresh-replayed');
        });

        it('a CONCURRENT double-spend never leaves two live credentials', async () => {
            // The atomic-claim proof. A check-then-act implementation passes
            // every sequential test above and fails this one.
            //
            // The OUTCOME is deliberately not asserted. Two simultaneous
            // rotations may both read the token as unspent (one wins the claim,
            // the loser burns the family) or the second may arrive just after
            // the first committed (absorbed by the grace path above). The race
            // decides which, so pinning a winner COUNT would make this flaky
            // rather than strict.
            //
            // What must hold either way is the property the atomic claim
            // exists for: the token is spent exactly once, and the session is
            // never left holding two independently-usable credentials. Under
            // check-then-act both callers mint a successor from the same
            // parent and this count is 2.
            const s = await makeSession();
            const first = await issueFor(s);

            await Promise.all([
                rotateRefreshToken(first.raw),
                rotateRefreshToken(first.raw),
            ]);

            const spent = await db.nativeRefreshToken.findUnique({
                where: { tokenHash: hashToken(first.raw) },
                select: { consumedAt: true, replacedById: true },
            });
            expect(spent!.consumedAt).not.toBeNull();
            expect(spent!.replacedById).not.toBeNull();

            const live = await db.nativeRefreshToken.count({
                where: { userSessionId: s.id, consumedAt: null, revokedAt: null },
            });
            expect(live).toBeLessThanOrEqual(1);

            const rows = await db.nativeRefreshToken.findMany({
                where: { userSessionId: s.id },
                select: { familyId: true },
            });
            expect(new Set(rows.map((r) => r.familyId)).size).toBe(1);
        });
    });

    describe('every existing session lever reaches the token, with no token-specific bookkeeping', () => {
        it('LEVER: admin revoke (revokedAt) invalidates refresh', async () => {
            const s = await makeSession();
            const t = await issueFor(s);
            // Exactly what DELETE /api/t/:slug/admin/sessions does.
            await db.userSession.update({
                where: { id: s.id },
                data: { revokedAt: new Date(), revokedReason: 'admin:test' },
            });
            const res = await rotateRefreshToken(t.raw);
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('session_invalid');
        });

        it('LEVER: session expiry invalidates refresh', async () => {
            const s = await makeSession({ expiresAt: new Date(Date.now() + 60_000) });
            const t = await issueFor(s);
            await db.userSession.update({
                where: { id: s.id },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });
            const res = await rotateRefreshToken(t.raw);
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('session_invalid');
        });

        it('LEVER: maxConcurrentSessions eviction invalidates refresh', async () => {
            // The cap works by stamping revokedAt on the oldest row, so this
            // asserts the eviction SHAPE rather than re-running the evictor.
            const s = await makeSession();
            const t = await issueFor(s);
            await db.userSession.update({
                where: { id: s.id },
                data: { revokedAt: new Date(), revokedReason: 'policy:concurrent-limit' },
            });
            const res = await rotateRefreshToken(t.raw);
            expect(res.ok).toBe(false);
        });

        it('revoking a session sweeps its tokens too, so nothing is left claimable', async () => {
            const s = await makeSession();
            const t = await issueFor(s);
            const n = await revokeTokensForSession(s.id, 'admin:test');
            expect(n).toBeGreaterThanOrEqual(1);
            const res = await rotateRefreshToken(t.raw);
            expect(res.ok).toBe(false);
        });
    });

    describe('a refresh token can never outlive its session', () => {
        it('caps expiresAt to the session when the session ends sooner', async () => {
            const soon = new Date(Date.now() + 5 * 60 * 1000);
            const s = await makeSession({ expiresAt: soon });
            const t = await issueFor(s);
            // Requested 30 days; the session ends in 5 minutes.
            expect(t.expiresAt.getTime()).toBe(soon.getTime());
        });
    });

    describe('unknown and malformed tokens', () => {
        it('an unknown token is refused without touching anything', async () => {
            const res = await rotateRefreshToken('not-a-real-token');
            expect(res.ok).toBe(false);
            if (!res.ok) expect(res.reason).toBe('unknown');
        });
    });
});
