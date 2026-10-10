/**
 * P5.1 — trust & safety RLS (#1553).
 *
 * Four tables with no `tenantId`, which is exactly the blind spot
 * `exchange-messaging-rls` was written for: the `rls-coverage` inventory keys
 * off a `tenantId` COLUMN, so a full guard sweep passes over a tenantless
 * table that is completely unprotected. These four cannot have one —
 * moderation is a platform function and a person↔person block belongs to
 * neither party's farm — so the policies are asserted here, against the live
 * database, under the real `runInUserContext`.
 *
 * It matters more than usual that this exists now. P5's rule ships these
 * tables one release BEFORE any code writes them, so there is no route to
 * catch a mistake and no traffic to reveal one. The RLS is the only thing
 * standing between the first writer and a leak, and
 * `ALTER DEFAULT PRIVILEGES` (migration 20260323180000) already grants
 * `app_user` SELECT/INSERT/UPDATE/DELETE on every new table in `public` — so
 * these are reachable by a tenant session the moment they exist.
 *
 * ── the shape of the negatives, and why it is not optional ──
 *
 * Under RLS a write is refused with `42501` only when the row is VISIBLE.
 * When SELECT hides it, a DELETE affects ZERO rows and returns normally. So
 * every negative here asserts a row COUNT or a raised code, never that a call
 * returned — and the `UserBlock` delete case is precisely the one where the
 * difference bites, because SELECT deliberately admits the blocked party.
 *
 * ── and why the POSITIVES carry the same weight ──
 *
 * `app.user_id` is unset under a tenant context, `current_setting(…, true)`
 * yields NULL, and every arm then matches nothing. That is fail-closed but
 * SILENT: for a block it means the table stops refusing rather than erroring.
 * An assertion that a party sees "no more than their own" passes on an empty
 * result and proves nothing, so each positive asserts a NON-ZERO count.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { runInUserContext } from '@/lib/db-context';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { encryptField } from '@/lib/security/encryption';
import type { UserContext } from '@/app-layer/types';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

// Synthetic person ids. None of these tables has an FK to `User` — every
// person column is a plain string, following `ExchangeBlock` — so no user
// fixture is needed, and inventing one would test a constraint that does not
// exist.
const BLOCKER = `u-p51-blocker-${randomUUID()}`;
const BLOCKED = `u-p51-blocked-${randomUUID()}`;
const OUTSIDER = `u-p51-outsider-${randomUUID()}`;
const REPORTER = `u-p51-reporter-${randomUUID()}`;

const BLOCK_ROW = `ub-${randomUUID()}`;
const REPORT_MINE = `cr-mine-${randomUUID()}`;
const REPORT_OTHER = `cr-other-${randomUUID()}`;
const REPORT_ANON = `cr-anon-${randomUUID()}`;
const ACTION_ROW = `ma-${randomUUID()}`;
const SOR_ROW = `sor-${randomUUID()}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** Count rows VISIBLE to this person, via raw SQL so the ORM cannot filter. */
async function visibleCount(userId: string, table: string): Promise<number> {
    return runInUserContext(ctxFor(userId), async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "${table}"`,
        );
        return Number(rows[0].n);
    });
}

describeFn('P5.1 — trust & safety RLS (#1553)', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        // Seeded as the OWNER role, so `superuser_bypass` applies — the
        // production write path for all four of these tables is a
        // platform-admin surface, not a tenant session.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId") VALUES ($1,$2,$3)`,
            BLOCK_ROW, BLOCKER, BLOCKED,
        );
        // `detail` is in ENCRYPTED_FIELDS, so a raw insert stores the envelope
        // the middleware would have written. Plaintext here would make a later
        // ORM read fail to decrypt for a reason unrelated to RLS.
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ContentReport"("id","reporterUserId","subjectKind","subjectId","reasonCode","detail")
             VALUES ($1,$2,'LISTING',$3,'MISLEADING_LISTING',$4),
                    ($5,$6,'LISTING',$7,'SPAM',$8),
                    ($9,NULL,'PROFILE',$10,'HARASSMENT_OR_HATE',$11)`,
            REPORT_MINE, REPORTER, `listing-${randomUUID()}`, encryptField('grade is not as stated'),
            REPORT_OTHER, OUTSIDER, `listing-${randomUUID()}`, encryptField('bulk postings'),
            REPORT_ANON, `profile-${randomUUID()}`, encryptField('an anonymous Art 16 notice'),
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "ModerationAction"("id","moderatorRef","actionKind","subjectKind","subjectId","rationale")
             VALUES ($1,'mod:key-7','CONTENT_REMOVED','LISTING',$2,$3)`,
            ACTION_ROW, `listing-${randomUUID()}`, encryptField('grade claim unsubstantiated'),
        );
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "StatementOfReasons"("id","actionId","recipientUserId","locale","bodyRendered")
             VALUES ($1,$2,$3,'bg',$4)`,
            SOR_ROW, ACTION_ROW, OUTSIDER, encryptField('Вашата обява беше премахната.'),
        );
    });

    afterAll(async () => {
        for (const [table, col, val] of [
            ['StatementOfReasons', 'id', SOR_ROW],
            ['ModerationAction', 'id', ACTION_ROW],
            ['ContentReport', 'id', REPORT_MINE],
            ['ContentReport', 'id', REPORT_OTHER],
            ['ContentReport', 'id', REPORT_ANON],
            ['UserBlock', 'id', BLOCK_ROW],
        ] as const) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "${table}" WHERE "${col}" = $1`, val,
            );
        }
        await globalPrisma.$disconnect();
    });

    it('enters app_user — without which every assertion here is inert', async () => {
        // The precondition for all of it. `superuser_bypass` makes these
        // policies invisible to the owner role, so a suite that failed to
        // change role would pass every negative below for the wrong reason.
        const role = await runInUserContext(ctxFor(BLOCKER), async (tx) => {
            const r = await tx.$queryRawUnsafe<Array<{ r: string }>>(`SELECT current_user AS r`);
            return r[0].r;
        });
        expect(role).toBe('app_user');
    });

    describe('UserBlock — the blocked party reads it and cannot delete it', () => {
        it('the BLOCKER sees the row', async () => {
            expect(await visibleCount(BLOCKER, 'UserBlock')).toBeGreaterThan(0);
        });

        it('the BLOCKED party sees it too — the wide SELECT arm', async () => {
            // The asymmetry's whole purpose. The block is enforced while
            // running in the blocked person's context, so a row they cannot
            // see cannot refuse them. A non-zero count, because zero is what a
            // silently-unset `app.user_id` also produces.
            expect(await visibleCount(BLOCKED, 'UserBlock')).toBeGreaterThan(0);
        });

        it('an OUTSIDER sees none of it', async () => {
            expect(await visibleCount(OUTSIDER, 'UserBlock')).toBe(0);
        });

        it('the BLOCKED party cannot DELETE it — asserted as a row count', async () => {
            // The case the split policy exists for, and the case where
            // "it did not throw" would be the wrong assertion: the row IS
            // visible to this person, so a single USING clause would have
            // allowed the delete outright. With the arms split, the DELETE
            // policy names the blocker only and the statement affects zero
            // rows WITHOUT raising.
            await runInUserContext(ctxFor(BLOCKED), async (tx) => {
                const n = await tx.$executeRawUnsafe(
                    `DELETE FROM "UserBlock" WHERE "id" = $1`, BLOCK_ROW,
                );
                expect(n).toBe(0);
            });
            // And the row is still there, read back outside the transaction.
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "UserBlock" WHERE "id" = $1`, BLOCK_ROW,
            );
            expect(Number(rows[0].n)).toBe(1);
        });

        it('the BLOCKED party cannot forge a block naming someone else as blocker', async () => {
            // `WITH CHECK` on the INSERT arm. Without it, anyone could write a
            // row claiming any person had blocked any other.
            await expect(
                runInUserContext(ctxFor(BLOCKED), (tx) =>
                    tx.$executeRawUnsafe(
                        `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId")
                         VALUES ($1,$2,$3)`,
                        `ub-forged-${randomUUID()}`, OUTSIDER, BLOCKER,
                    ),
                ),
            ).rejects.toThrow(/42501|row-level security/i);
        });

        it('the BLOCKER can delete their own block', async () => {
            // The positive half. Without it, a policy that refused EVERY
            // delete would pass every assertion above.
            const temp = `ub-temp-${randomUUID()}`;
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "UserBlock"("id","blockerUserId","blockedUserId") VALUES ($1,$2,$3)`,
                temp, BLOCKER, OUTSIDER,
            );
            await runInUserContext(ctxFor(BLOCKER), async (tx) => {
                const n = await tx.$executeRawUnsafe(
                    `DELETE FROM "UserBlock" WHERE "id" = $1`, temp,
                );
                expect(n).toBe(1);
            });
        });
    });

    describe('ContentReport — the reporter reads their OWN row, and only that', () => {
        it('the reporter sees exactly their own report', async () => {
            // Three rows exist: theirs, another person's, and an anonymous
            // one. Exactly 1 is the assertion — a count of 3 would mean the
            // arm admits everything, and 0 would mean it admits nothing.
            expect(await visibleCount(REPORTER, 'ContentReport')).toBe(1);
        });

        it('an unrelated person sees only theirs, not the reporter\'s', async () => {
            expect(await visibleCount(OUTSIDER, 'ContentReport')).toBe(1);
        });

        it('the ANONYMOUS notice is visible to nobody under app_user', async () => {
            // `NULL = NULL` is NULL in SQL, not true, so a row with no
            // reporter matches no reporter. Asserted directly rather than
            // inferred from the counts above, because that is the property
            // DECISION 5 relies on.
            const n = await runInUserContext(ctxFor(REPORTER), async (tx) => {
                const r = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "ContentReport" WHERE "id" = $1`,
                    REPORT_ANON,
                );
                return Number(r[0].n);
            });
            expect(n).toBe(0);
        });

        it('a reporter cannot INSERT a report directly', async () => {
            // The arm is SELECT-only on purpose: a direct insert could forge
            // `reporterUserId` or set any `status`. Notices arrive through the
            // P5.2 platform surface, which sanitises them.
            await expect(
                runInUserContext(ctxFor(REPORTER), (tx) =>
                    tx.$executeRawUnsafe(
                        `INSERT INTO "ContentReport"("id","reporterUserId","subjectKind","subjectId","reasonCode")
                         VALUES ($1,$2,'LISTING',$3,'SPAM')`,
                        `cr-forged-${randomUUID()}`, REPORTER, `listing-${randomUUID()}`,
                    ),
                ),
            ).rejects.toThrow(/42501|row-level security/i);
        });

        it('a reporter cannot UPDATE their own report — and it does NOT raise', async () => {
            // The asymmetry worth stating, because the two negatives above and
            // this one look like they should behave the same way and do not:
            //
            //   * the INSERT raises 42501 — a WITH CHECK violation is an error.
            //   * this UPDATE raises NOTHING. With no permissive UPDATE policy,
            //     the rows to update are selected by a USING clause that is
            //     effectively false, so the statement matches zero rows and
            //     returns normally.
            //
            // Which is why this asserts a row COUNT and then re-reads the
            // value. `.rejects.toThrow()` was the first thing written here and
            // it failed — the promise resolved to 0 — so an expectation of a
            // thrown error would have been a guard that could only ever be
            // satisfied by changing Postgres.
            const affected = await runInUserContext(ctxFor(REPORTER), (tx) =>
                tx.$executeRawUnsafe(
                    `UPDATE "ContentReport" SET "status" = 'REJECTED' WHERE "id" = $1`,
                    REPORT_MINE,
                ),
            );
            expect(affected).toBe(0);
            // And the value is untouched, read back on the privileged path.
            // The count alone would pass if the row had been deleted.
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ status: string }>>(
                `SELECT "status"::text AS status FROM "ContentReport" WHERE "id" = $1`,
                REPORT_MINE,
            );
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('RECEIVED');
        });
    });

    describe('ModerationAction and StatementOfReasons — platform only', () => {
        it('no app_user session reads a ModerationAction', async () => {
            for (const who of [REPORTER, OUTSIDER, BLOCKER]) {
                expect(await visibleCount(who, 'ModerationAction')).toBe(0);
            }
        });

        it('no app_user session reads a StatementOfReasons', async () => {
            // Including its RECIPIENT. DSA Art 17 is satisfied by delivery —
            // a push in the recipient's language per P5.4 — not by read
            // access, and a row-level arm here would expose `actionId` and
            // through it the moderation rationale.
            expect(await visibleCount(OUTSIDER, 'StatementOfReasons')).toBe(0);
        });

        it('no app_user session can write to either', async () => {
            await expect(
                runInUserContext(ctxFor(OUTSIDER), (tx) =>
                    tx.$executeRawUnsafe(
                        `INSERT INTO "ModerationAction"("id","moderatorRef","actionKind","subjectKind","subjectId","rationale")
                         VALUES ($1,'mod:forged','ACCOUNT_TERMINATED','PROFILE',$2,$3)`,
                        `ma-forged-${randomUUID()}`, `profile-${randomUUID()}`, 'forged',
                    ),
                ),
            ).rejects.toThrow(/42501|row-level security/i);
            await expect(
                runInUserContext(ctxFor(OUTSIDER), (tx) =>
                    tx.$executeRawUnsafe(
                        `INSERT INTO "StatementOfReasons"("id","actionId","recipientUserId","locale","bodyRendered")
                         VALUES ($1,$2,$3,'bg','forged')`,
                        `sor-forged-${randomUUID()}`, ACTION_ROW, OUTSIDER,
                    ),
                ),
            ).rejects.toThrow(/42501|row-level security/i);
        });
    });

    it('the OWNER role still sees everything — sweeps, seeds and migrations', async () => {
        // A policy set that broke the privileged path would be a false pass:
        // every negative above would hold for the wrong reason.
        for (const [table, id] of [
            ['UserBlock', BLOCK_ROW],
            ['ContentReport', REPORT_ANON],
            ['ModerationAction', ACTION_ROW],
            ['StatementOfReasons', SOR_ROW],
        ] as const) {
            const r = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "${table}" WHERE "id" = $1`, id,
            );
            expect(Number(r[0].n)).toBe(1);
        }
    });
});
