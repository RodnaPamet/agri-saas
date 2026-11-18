/**
 * #3177 — the unverified-account sweep deletes abandoned PASSWORD sign-ups and
 * nothing else, asserted against a real database.
 *
 * The predicate used to be `emailVerified: null` alone. next-auth creates every
 * Google / Entra user with `emailVerified: null` and nothing sets it later, so
 * a Google user with no farm after a week was deleted; so were membership-less
 * system users, and suspended or erased accounts whose `User` row is kept on
 * purpose.
 *
 * The unit suite mocks Prisma, so it can say which `where` was built but not
 * which rows it selects. This suite runs the real query over one row of each
 * kind and asserts the survivors by id — with a positive control, because
 * "deleted nothing" also satisfies every negative.
 */
import { randomUUID } from 'crypto';
import { prisma } from '@/lib/prisma';
import { runUnverifiedAccountSweep } from '@/app-layer/jobs/unverified-account-sweep';
import { DB_AVAILABLE } from './db-helper';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const S = randomUUID().slice(0, 8);
const OLD = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const NOW = new Date();

const ids = {
    abandonedSignup: `u-sweep-pw-${S}`,
    googleUser: `u-sweep-google-${S}`,
    ssoUser: `u-sweep-sso-${S}`,
    systemUser: `u-sweep-system-${S}`,
    suspended: `u-sweep-susp-${S}`,
    erased: `u-sweep-erased-${S}`,
    deletionPending: `u-sweep-delreq-${S}`,
};

describeFn('unverified-account-sweep — who may be deleted (#3177)', () => {
    beforeAll(async () => {
        const base = (id: string, extra: Record<string, unknown> = {}) =>
            prisma.user.create({
                data: { id, email: `${id}@example.test`, createdAt: OLD, emailVerified: null, ...extra },
            });

        await base(ids.abandonedSignup, { passwordHash: 'x-not-a-real-hash' });
        await base(ids.googleUser);
        await prisma.account.create({
            data: { userId: ids.googleUser, type: 'oauth', provider: 'google', providerAccountId: `g-${S}` },
        });
        await base(ids.ssoUser);
        await base(ids.systemUser);
        await base(ids.suspended, { passwordHash: 'x', suspendedAt: OLD });
        await base(ids.erased, { passwordHash: 'x', pseudonymisedAt: OLD });
        await base(ids.deletionPending, { passwordHash: 'x', deletionRequestedAt: OLD });
    });

    afterAll(async () => {
        await prisma.account.deleteMany({ where: { userId: ids.googleUser } });
        await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    });

    it('deletes the abandoned password sign-up and spares every other kind', async () => {
        // Large batch: other suites' rows may share the table, and the sweep is
        // oldest-first, so a small batch could stop before reaching these.
        await runUnverifiedAccountSweep(prisma as never, { now: NOW, batchSize: 100_000 });

        const left = await prisma.user.findMany({
            where: { id: { in: Object.values(ids) } },
            select: { id: true },
        });
        const survivors = new Set(left.map((u) => u.id));

        // The positive control: without it, a sweep that deleted nothing passes.
        expect(survivors.has(ids.abandonedSignup)).toBe(false);

        for (const kept of [
            ids.googleUser, ids.ssoUser, ids.systemUser,
            ids.suspended, ids.erased, ids.deletionPending,
        ]) {
            expect({ id: kept, survived: survivors.has(kept) }).toEqual({ id: kept, survived: true });
        }
    });
});
