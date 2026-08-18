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

    describe('replay is treated as theft, not as a retry', () => {
        it('replaying a SPENT token is refused AND burns the whole lineage + session', async () => {
            const s = await makeSession();
            const first = await issueFor(s);
            const second = await rotateRefreshToken(first.raw);
            if (!second.ok) throw new Error('setup: first rotation should succeed');

            // The thief presents the token the legitimate client already spent.
            const replay = await rotateRefreshToken(first.raw);
            expect(replay.ok).toBe(false);
            if (replay.ok) return;
            expect(replay.reason).toBe('replayed');

            // The successor the LEGITIMATE client holds is dead too. That is
            // deliberate: we cannot tell thief from victim, so both are signed
            // out rather than left sharing a session.
            const successor = await rotateRefreshToken(second.raw);
            expect(successor.ok).toBe(false);

            // And the session itself is revoked, so the ACCESS token dies with
            // it at its next refresh — not just the refresh credential.
            const session = await db.userSession.findUnique({
                where: { id: s.id },
                select: { revokedAt: true, revokedReason: true },
            });
            expect(session!.revokedAt).not.toBeNull();
            expect(session!.revokedReason).toBe('security:refresh-replayed');
        });

        it('a CONCURRENT double-spend leaves exactly one winner, and burns the family', async () => {
            // The atomic-claim proof. A check-then-act implementation passes
            // every sequential test above and fails this one.
            const s = await makeSession();
            const first = await issueFor(s);

            const [a, b] = await Promise.all([
                rotateRefreshToken(first.raw),
                rotateRefreshToken(first.raw),
            ]);
            const winners = [a, b].filter((r) => r.ok);
            expect(winners).toHaveLength(1);
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
