/**
 * «Вдъхновение» — `Book` / `BookChapter` RLS (#2980).
 *
 * Two tenantless tables, which is the blind spot `rls-coverage` exists to
 * leave: that inventory keys off a `tenantId` COLUMN, so a full green sweep
 * passes straight over a tenantless table with no protection at all. And
 * migration `20260323180000`'s `ALTER DEFAULT PRIVILEGES` already grants
 * `app_user` SELECT/INSERT/UPDATE/DELETE on every new table in `public`, so
 * these are reachable by a session the moment they exist.
 *
 * This is a SCHEMA-ONLY release, so there is no route to catch a mistake and
 * no traffic to reveal one — the policies are the whole of the protection
 * until the reads land, and this file is the only thing that executes them.
 *
 * ── the three properties, and the controls that make each mean something ──
 *
 * **1. A published book is readable by any authenticated caller, in EITHER
 * session context.** `runInUserContext` sets `app.user_id`;
 * `runInTenantContext` sets `app.actor_user_id` and not the other. #1664 is
 * what picking one costs — the arm matches nothing, the read returns zero
 * rows, and nothing errors. Both are asserted against the REAL runners, and
 * the control is the unauthenticated case below: without it, "admits both" is
 * indistinguishable from "admits everyone".
 *
 * **2. It widens nothing**, asserted as a COMPARISON of the visible id SETS
 * under the two contexts rather than as two counts that happen to agree. Two
 * numbers matching is satisfied by a policy admitting everything.
 *
 * **3. An UNPUBLISHED book reaches nobody** — not the book row, and not its
 * chapters. The chapter half is the one that matters: hiding the book while
 * serving its text is the whole of the leak, not a partial fix of it. The
 * owner's constraint is that publishing waits for their review, so production
 * WILL hold unpublished rows, and that window is the column's purpose.
 *
 * ── the shape of the negatives ──
 *
 * Under RLS a write is refused with `42501` only when the row is VISIBLE.
 * With no permissive policy for the command, the rows to change are selected
 * by a USING clause that is effectively false, so an UPDATE or DELETE affects
 * ZERO rows and returns normally. So every negative asserts a row COUNT or a
 * raised code — never that a call returned.
 *
 * SQLSTATE arrives in the MESSAGE, not in `err.meta.code`: Prisma wraps a raw
 * query failure as `P2010`. P9.1 reported all seven of its refusals as `P2010`
 * on the first run for exactly this reason, and `p5-1-trust-safety-rls`
 * already matched on the message. When an RLS negative fails here, check what
 * the reader is reading before changing a policy.
 *
 * ── and why every negative is PAIRED with a positive ──
 *
 * P8.1's three `REFUSES …` cases all passed while the rule enforced nothing,
 * because a recursive policy meant nothing could insert at all. A suite of
 * only negatives would have shipped that green.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { runInTenantContext, runInUserContext } from '@/lib/db-context';
import { encryptField, hashForLookup } from '@/lib/security/encryption';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const PUBLISHED_ID = `bk-pub-${randomUUID()}`;
const DRAFT_ID = `bk-draft-${randomUUID()}`;
const bookIds = [PUBLISHED_ID, DRAFT_ID];

const userCtx = (userId: string) => ({ userId, requestId: `req-${randomUUID()}` }) as never;
const tenantCtx = (userId: string, tenantId: string) =>
    ({ userId, tenantId, requestId: `req-${randomUUID()}`, role: 'EDITOR' }) as never;

/** A person row, so the tenant-context direction has a real membership. */
async function makeUser(label: string): Promise<string> {
    const id = `u-2980-${label}-${randomUUID()}`;
    const email = `${id}@example.test`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "User"("id","emailEncrypted","emailHash","updatedAt")
         VALUES ($1,$2,$3,NOW())`,
        id, encryptField(email), hashForLookup(email),
    );
    return id;
}

async function makeTenantWith(userId: string): Promise<{ tenantId: string; membershipId: string }> {
    const tenantId = `t-2980-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Tenant"("id","name","slug","updatedAt") VALUES ($1,'Library farm',$2,NOW())`,
        tenantId, `lib2980-${randomUUID()}`.slice(0, 40),
    );
    const membershipId = `tm-2980-${randomUUID()}`;
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "TenantMembership"("id","tenantId","userId","role","status","updatedAt")
         VALUES ($1,$2,$3,'EDITOR','ACTIVE',NOW())`,
        membershipId, tenantId, userId,
    );
    return { tenantId, membershipId };
}

/** Seed a book PRIVILEGED — there is deliberately no `app_user` write arm. */
async function seedBook(id: string, published: boolean, chapters: number): Promise<void> {
    await globalPrisma.$executeRawUnsafe(
        `INSERT INTO "Book"("id","slug","title","author","locale","sourceNote","licenseNote",
                           "version","useCases","publishedAt","updatedAt")
         VALUES ($1,$2,'Книга','Автор','bg','Източник','Лиценз',1,
                 ARRAY['STRATEGY']::"BookUseCase"[], ${published ? 'NOW()' : 'NULL'}, NOW())`,
        id, `slug-${id}`,
    );
    for (let n = 1; n <= chapters; n += 1) {
        await globalPrisma.$executeRawUnsafe(
            `INSERT INTO "BookChapter"("id","bookId","number","title","paragraphs")
             VALUES ($1,$2,$3,$4, ARRAY['Първи абзац','Втори абзац']::TEXT[])`,
            `bc-${id}-${n}`, id, n, `Глава ${n}`,
        );
    }
}

describeFn('#2980 — the library is readable signed-in, and only once published', () => {
    let reader = '';
    let tenantId = '';
    let membershipId = '';

    beforeAll(async () => {
        await globalPrisma.$connect();
        reader = await makeUser('reader');
        ({ tenantId, membershipId } = await makeTenantWith(reader));
        await seedBook(PUBLISHED_ID, true, 2);
        await seedBook(DRAFT_ID, false, 2);
    });

    afterAll(async () => {
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "BookChapter" WHERE "bookId" = ANY($1::text[])`, bookIds,
        );
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "Book" WHERE "id" = ANY($1::text[])`, bookIds,
        );
        if (membershipId) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "id" = $1`, membershipId,
            );
        }
        if (tenantId) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId);
        }
        if (reader) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, reader);
        }
        await globalPrisma.$disconnect();
    });

    /** The ids this suite seeded that are visible under `runInUserContext`. */
    const idsUnderUserContext = () =>
        runInUserContext(userCtx(reader), async (tx) => {
            const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "Book" WHERE "id" = ANY($1::text[]) ORDER BY "id"`, bookIds,
            );
            return rows.map((r) => r.id);
        });

    /** The same question under `runInTenantContext`, which sets the OTHER variable. */
    const idsUnderTenantContext = () =>
        runInTenantContext(tenantCtx(reader, tenantId), async (tx) => {
            const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
                `SELECT "id" FROM "Book" WHERE "id" = ANY($1::text[]) ORDER BY "id"`, bookIds,
            );
            return rows.map((r) => r.id);
        });

    describe('a PUBLISHED book reaches an authenticated caller in either context', () => {
        it('is visible under runInUserContext — app.user_id', async () => {
            expect(await idsUnderUserContext()).toEqual([PUBLISHED_ID]);
        });

        it('is visible under runInTenantContext — app.actor_user_id', async () => {
            // The arm that removes #1664's trap. The library read is
            // person-scoped, so production takes the user-context path; this
            // direction exists so a later tenant-scoped caller is not silently
            // handed an empty library.
            expect(await idsUnderTenantContext()).toEqual([PUBLISHED_ID]);
        });

        it('admits the SAME SET under both contexts, so neither widens the other', async () => {
            // A comparison, not two counts: "both return 1" is satisfied by a
            // policy admitting everything.
            const [a, b] = await Promise.all([idsUnderUserContext(), idsUnderTenantContext()]);
            expect(a).toEqual(b);
            // …and a control that the set is not empty, which would satisfy the
            // equality while proving nothing.
            expect(a.length).toBeGreaterThan(0);
        });

        it('serves its CHAPTERS to the same caller', async () => {
            const n = await runInUserContext(userCtx(reader), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "BookChapter" WHERE "bookId" = $1`,
                    PUBLISHED_ID,
                );
                return Number(rows[0].n);
            });
            expect(n).toBe(2);
        });
    });

    describe('an UNPUBLISHED book reaches nobody holding app_user', () => {
        it('the book row is invisible in both contexts', async () => {
            expect(await idsUnderUserContext()).not.toContain(DRAFT_ID);
            expect(await idsUnderTenantContext()).not.toContain(DRAFT_ID);
        });

        it('and so are its CHAPTERS — the half that is the actual leak', async () => {
            // Hiding the book row while serving its text would satisfy a
            // book-only assertion and publish the text the owner has not read.
            const n = await runInUserContext(userCtx(reader), async (tx) => {
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "BookChapter" WHERE "bookId" = $1`,
                    DRAFT_ID,
                );
                return Number(rows[0].n);
            });
            expect(n).toBe(0);
            // The positive control, in the same test: the rows DO exist, so
            // zero means refused rather than never written.
            const seeded = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
                `SELECT COUNT(*)::bigint AS n FROM "BookChapter" WHERE "bookId" = $1`, DRAFT_ID,
            );
            expect(Number(seeded[0].n)).toBe(2);
        });
    });

    describe('the controls', () => {
        it('an app_user session with NEITHER variable set sees ZERO books', async () => {
            // Without this, "the policy admits both variables" and "the policy
            // admits every app_user session" are the same observation.
            const n = await globalPrisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "Book" WHERE "id" = ANY($1::text[])`,
                    bookIds,
                );
                return Number(rows[0].n);
            });
            expect(n).toBe(0);
        });

        it('and ZERO chapters, so the parent check is not the only gate', async () => {
            const n = await globalPrisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
                const rows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
                    `SELECT COUNT(*)::bigint AS n FROM "BookChapter" WHERE "bookId" = ANY($1::text[])`,
                    bookIds,
                );
                return Number(rows[0].n);
            });
            expect(n).toBe(0);
        });
    });

    describe('there is no app_user WRITE path, which the seed depends on', () => {
        it('REFUSES an insert, while the privileged seed above succeeded', async () => {
            const message = await runInUserContext(userCtx(reader), async (tx) => {
                try {
                    await tx.$executeRawUnsafe(
                        `INSERT INTO "Book"("id","slug","title","author","locale",
                                            "sourceNote","licenseNote","updatedAt")
                         VALUES ($1,$2,'Forged','Forger','bg','x','y',NOW())`,
                        `bk-forged-${randomUUID()}`, `forged-${randomUUID()}`,
                    );
                    return null;
                } catch (err) {
                    return err instanceof Error ? err.message : String(err);
                }
            }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
            // 42501 is in the MESSAGE; Prisma reports the wrapper code P2010.
            expect(message).toContain('42501');
        });

        it('leaves a published book UNCHANGED on an app_user update — zero rows, no error', async () => {
            // No UPDATE policy exists, so the statement is legal and matches
            // nothing. Asserting it "did not throw" would pass either way.
            await runInUserContext(userCtx(reader), (tx) =>
                tx.$executeRawUnsafe(`UPDATE "Book" SET "title" = 'Rewritten' WHERE "id" = $1`,
                    PUBLISHED_ID),
            );
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ title: string }>>(
                `SELECT "title" FROM "Book" WHERE "id" = $1`, PUBLISHED_ID,
            );
            expect(rows[0].title).toBe('Книга');
        });
    });

    describe('a chapter cannot exist with no paragraphs', () => {
        it('REFUSES an empty array with 23514, and accepts a non-empty one', async () => {
            // `cardinality(...) > 0`, not `array_length(x, 1) >= 1` —
            // `array_length` is NULL for an empty array and a NULL CHECK PASSES,
            // so the wrong spelling admits exactly the row it exists to refuse.
            let message: string | null = null;
            try {
                await globalPrisma.$executeRawUnsafe(
                    `INSERT INTO "BookChapter"("id","bookId","number","title","paragraphs")
                     VALUES ($1,$2,99,'Пуста глава', ARRAY[]::TEXT[])`,
                    `bc-empty-${randomUUID()}`, PUBLISHED_ID,
                );
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message).toContain('23514');

            // The positive control: the same insert with one paragraph lands.
            const okId = `bc-ok-${randomUUID()}`;
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "BookChapter"("id","bookId","number","title","paragraphs")
                 VALUES ($1,$2,98,'Пълна глава', ARRAY['Един абзац']::TEXT[])`,
                okId, PUBLISHED_ID,
            );
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "BookChapter" WHERE "id" = $1`, okId);
        });
    });
});
