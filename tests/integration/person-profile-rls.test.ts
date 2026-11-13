/**
 * #3007 — PersonProfile's policies, with the negative controls the bucket
 * entry demanded before they could be written.
 *
 * `rls-coverage`'s entry for this table named the condition: "The policy
 * belongs to the FIRST PR that routes a person-scoped read through app_user …
 * which is also the only PR that can write an integration test with real
 * negative controls for it, and a control that cannot express failure is green
 * for ever." #2989 was that PR and shipped without the policy; this is the
 * test it owed.
 *
 * ## The shape of the negatives
 *
 * Under RLS a write is refused with `42501` only when the row is VISIBLE.
 * Where SELECT hides it, an UPDATE or DELETE affects ZERO rows and returns
 * normally — so every negative asserts a row COUNT or a raised code, never
 * that a call returned.
 *
 * ## And every negative is PAIRED with a positive
 *
 * P8.1 is why that is a rule here: all three of its refusal cases passed while
 * the rule enforced nothing, because a recursive policy meant nothing could
 * insert at all. A suite of only-negatives is satisfied perfectly by a table
 * nobody can touch. So "a stranger sees the published row" sits beside "a
 * stranger cannot see the unpublished one", and the pair is the evidence.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInUserContext } from '@/lib/db-context';
import { hashForLookup } from '@/lib/security/encryption';
import type { UserContext } from '@/app-layer/types';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
/** Publishes a profile. */
const PUBLISHER = `u-ppr-pub-${TAG}`;
/** Has a profile that is NOT published. */
const PRIVATE = `u-ppr-priv-${TAG}`;
/** Has no profile, and is the stranger doing the reading. */
const STRANGER = `u-ppr-str-${TAG}`;

const RLS_REFUSAL = /row-level security|insufficient privilege|permission denied/i;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** How many PersonProfile rows this caller can SEE. */
async function visibleTo(userId: string): Promise<number> {
    return runInUserContext(ctxFor(userId), async (tx) => {
        const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "PersonProfile" WHERE "userId" = ANY($1)`,
            [PUBLISHER, PRIVATE, STRANGER],
        );
        return Number(rows[0]?.n ?? 0);
    });
}

async function writeAs(userId: string, sql: string, ...params: unknown[]) {
    try {
        const n = await runInUserContext(ctxFor(userId), (tx) =>
            tx.$executeRawUnsafe(sql, ...params),
        );
        return { refused: null as string | null, rows: n };
    } catch (err) {
        return { refused: err instanceof Error ? err.message : String(err), rows: -1 };
    }
}

describeFn('#3007 — PersonProfile RLS', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        for (const id of [PUBLISHER, PRIVATE, STRANGER]) {
            const email = `${id}@example.test`;
            await globalPrisma.user.create({
                data: { id, email, emailHash: hashForLookup(email) },
            });
        }
        // Seeded through the global client, which carries no `app_user` role,
        // so `superuser_bypass` applies — the same posture the erasure path
        // and the data export use.
        await globalPrisma.personProfile.create({
            data: { userId: PUBLISHER, displayName: 'Иван Петров', published: true },
        });
        await globalPrisma.personProfile.create({
            data: { userId: PRIVATE, displayName: 'Георги Иванов', published: false },
        });
    });

    afterAll(async () => {
        await globalPrisma.personProfile.deleteMany({
            where: { userId: { in: [PUBLISHER, PRIVATE, STRANGER] } },
        });
        await globalPrisma.user.deleteMany({
            where: { id: { in: [PUBLISHER, PRIVATE, STRANGER] } },
        });
        await globalPrisma.$disconnect();
    });

    describe('reading', () => {
        it('a STRANGER sees the published profile — this is the feature', async () => {
            // The positive half. Without it, "the unpublished one is hidden"
            // is satisfied by a policy that admits nobody.
            const seen = await runInUserContext(ctxFor(STRANGER), async (tx) =>
                tx.$queryRawUnsafe<Array<{ displayName: string | null }>>(
                    `SELECT "displayName" FROM "PersonProfile" WHERE "userId" = $1`,
                    PUBLISHER,
                ),
            );
            expect(seen).toHaveLength(1);
            expect(seen[0].displayName).toBe('Иван Петров');
        }, 60_000);

        it('a STRANGER cannot see an UNPUBLISHED profile', async () => {
            // The assertion the whole issue is about. Until this policy the
            // `published = true` clause in `resolveAuthors` was the only
            // thing withholding this name.
            const seen = await runInUserContext(ctxFor(STRANGER), async (tx) =>
                tx.$queryRawUnsafe<Array<{ displayName: string | null }>>(
                    `SELECT "displayName" FROM "PersonProfile" WHERE "userId" = $1`,
                    PRIVATE,
                ),
            );
            expect(seen).toHaveLength(0);
        }, 60_000);

        it('the OWNER sees their own unpublished profile', async () => {
            // So the editor can read back a draft before publishing it. The
            // `_select_own` arm exists for exactly this and nothing else.
            const seen = await runInUserContext(ctxFor(PRIVATE), async (tx) =>
                tx.$queryRawUnsafe<Array<{ published: boolean }>>(
                    `SELECT "published" FROM "PersonProfile" WHERE "userId" = $1`,
                    PRIVATE,
                ),
            );
            expect(seen).toHaveLength(1);
            expect(seen[0].published).toBe(false);
        }, 60_000);

        it('the stranger sees ONE of the two rows, not zero and not both', async () => {
            // A count rather than two reads: it fails both ways, so a policy
            // that admitted everything and one that admitted nothing are both
            // caught by the same assertion.
            expect(await visibleTo(STRANGER)).toBe(1);
            // And the private user sees their own plus the published one.
            expect(await visibleTo(PRIVATE)).toBe(2);
        }, 60_000);
    });

    describe('writing', () => {
        it('a caller CAN insert their own profile', async () => {
            const out = await writeAs(
                STRANGER,
                `INSERT INTO "PersonProfile" ("id","userId","displayName","published","createdAt","updatedAt")
                 VALUES ($1,$2,$3,true,NOW(),NOW())`,
                randomUUID(), STRANGER, 'Петър Петров',
            );
            expect(out.refused).toBeNull();
            expect(out.rows).toBe(1);
        }, 60_000);

        it('a caller CANNOT insert a profile for somebody else', async () => {
            // INSERT is the one command that RAISES: a WITH CHECK violation is
            // 42501 rather than a silent zero.
            const out = await writeAs(
                STRANGER,
                `INSERT INTO "PersonProfile" ("id","userId","displayName","published","createdAt","updatedAt")
                 VALUES ($1,$2,$3,true,NOW(),NOW())`,
                randomUUID(), `u-ppr-victim-${TAG}`, 'Чуждо име',
            );
            expect(out.refused).toMatch(RLS_REFUSAL);
        }, 60_000);

        it('a caller CANNOT rewrite a PUBLISHED name they can SEE', async () => {
            /*
             * The case a single `ALL` policy would have got wrong. The
             * stranger can READ this row — that is the author line — so a
             * USING clause of `published = true OR own` would have admitted
             * the UPDATE too and handed every authenticated caller the
             * ability to rename anybody.
             *
             * Asserted as a row COUNT, because an UPDATE the policy excludes
             * affects zero rows and returns normally rather than raising.
             */
            const out = await writeAs(
                STRANGER,
                `UPDATE "PersonProfile" SET "displayName" = $1 WHERE "userId" = $2`,
                'Присвоено име', PUBLISHER,
            );
            expect(out.refused).toBeNull();
            expect(out.rows).toBe(0);

            // And the name is untouched, read back privileged so the check is
            // not itself subject to the policy under test.
            const row = await globalPrisma.personProfile.findUniqueOrThrow({
                where: { userId: PUBLISHER },
                select: { displayName: true },
            });
            expect(row.displayName).toBe('Иван Петров');
        }, 60_000);

        it('a caller CAN update their own row', async () => {
            // The paired positive: the refusal above must not be "nobody can
            // update anything", which is what a missing arm would look like.
            const out = await writeAs(
                PUBLISHER,
                `UPDATE "PersonProfile" SET "displayName" = $1 WHERE "userId" = $2`,
                'Иван П. Петров', PUBLISHER,
            );
            expect(out.refused).toBeNull();
            expect(out.rows).toBe(1);
            // Put it back for the assertions above, which share this row.
            await globalPrisma.personProfile.update({
                where: { userId: PUBLISHER },
                data: { displayName: 'Иван Петров' },
            });
        }, 60_000);

        it('NOBODY can delete through app_user, not even their own row', async () => {
            // There is no DELETE arm, deliberately: erasure runs privileged,
            // and clearing a name is `setOwnDisplayName(null)`, which unpublishes
            // rather than destroying the row a channel post hangs off.
            const out = await writeAs(
                PUBLISHER,
                `DELETE FROM "PersonProfile" WHERE "userId" = $1`,
                PUBLISHER,
            );
            expect(out.refused).toBeNull();
            expect(out.rows).toBe(0);
            // Still there — the control that separates "refused" from "deleted".
            expect(
                await globalPrisma.personProfile.count({ where: { userId: PUBLISHER } }),
            ).toBe(1);
        }, 60_000);
    });

    it('the PRIVILEGED client still sees everything — erasure and export depend on it', async () => {
        // `FORCE ROW LEVEL SECURITY` applies policies even to the table owner,
        // so `superuser_bypass` is what keeps `eraseAccount` and the Art 15
        // export working. Without this assertion a policy change could make
        // both silently return nothing.
        const all = await globalPrisma.personProfile.count({
            where: { userId: { in: [PUBLISHER, PRIVATE, STRANGER] } },
        });
        expect(all).toBe(3);
    }, 60_000);
});
