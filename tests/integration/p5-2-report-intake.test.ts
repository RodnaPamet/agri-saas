/**
 * P5.2 — filing a notice and reading your own back (#1593).
 *
 * Drives the REAL usecase, not a hand-built query, because the thing under
 * test is a policy arm reached through `runInUserContext` and the mistake this
 * guards against is reaching it through the wrong runner. A test that issued
 * its own SQL would prove the policy works and say nothing about whether the
 * product uses it correctly — which is exactly the gap that let the issue
 * originally specify these routes under `/api/t/[slug]/`, where
 * `app.user_id` is unset and the arm silently matches nothing.
 *
 * ## The shape of the assertions
 *
 * `listOwnReports` has NO `where` on `reporterUserId` — the policy filters.
 * So "a reporter sees exactly their own" is a claim about the DATABASE here,
 * and it would fail if the policy were dropped. A `where` clause would have
 * made the same assertion pass with no policy at all, which is the one thing
 * it exists to catch.
 *
 * Every positive asserts a NON-ZERO count, because a silently-unset
 * `app.user_id` also yields zero and would make every negative pass for the
 * wrong reason.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { fileNotice, listOwnReports } from '@/app-layer/usecases/trust-safety';
import type { UserContext } from '@/app-layer/types';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const REPORTER = `u-p52-reporter-${randomUUID()}`;
const OTHER = `u-p52-other-${randomUUID()}`;

function ctxFor(userId: string): UserContext {
    return { requestId: `req-${randomUUID()}`, userId, email: `${userId}@example.test` };
}

/** Ids this suite created, so teardown does not depend on the usecase. */
const created: string[] = [];

async function file(
    reporter: string | null,
    over: Partial<Parameters<typeof fileNotice>[0]> = {},
) {
    const filed = await fileNotice(
        {
            subjectKind: 'LISTING',
            subjectId: `listing-${randomUUID()}`,
            reasonCode: 'MISLEADING_LISTING',
            detail: 'the grade is not as stated',
            ...over,
        },
        reporter,
    );
    created.push(filed.id);
    return filed;
}

describeFn('P5.2 — report intake and the reporter read arm (#1593)', () => {
    beforeAll(async () => { await globalPrisma.$connect(); });

    afterAll(async () => {
        if (created.length) {
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ReportSnapshot" WHERE "reportId" = ANY($1::text[])`, created,
            );
            await globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ContentReport" WHERE "id" = ANY($1::text[])`, created,
            );
        }
        await globalPrisma.$disconnect();
    });

    it('a notice is filed and acknowledged as RECEIVED', async () => {
        const filed = await file(REPORTER);
        expect(filed.id).toMatch(/^cr-/);
        expect(filed.status).toBe('RECEIVED');
    });

    it('the reporter reads their OWN notice back — the whole point of the arm', async () => {
        const mine = await listOwnReports(ctxFor(REPORTER));
        // NON-zero, because zero is also what a broken arm, a wrong runner or
        // an unset session variable produce.
        expect(mine.length).toBeGreaterThan(0);
        expect(mine.every((r) => created.includes(r.id))).toBe(true);
        expect(mine[0].status).toBe('RECEIVED');
        expect(mine[0].detail).toBe('the grade is not as stated');
    });

    it('another person reads NONE of it — and the filter is the policy, not a where', async () => {
        await file(OTHER);
        const theirs = await listOwnReports(ctxFor(OTHER));
        const mine = await listOwnReports(ctxFor(REPORTER));
        // Each sees their own and only their own. Both non-empty, so this is
        // not satisfied by a query that returns nothing to anybody.
        expect(theirs.length).toBeGreaterThan(0);
        expect(mine.length).toBeGreaterThan(0);
        const overlap = theirs.filter((t) => mine.some((m) => m.id === t.id));
        expect(overlap).toEqual([]);
    });

    it('an ANONYMOUS notice is readable by nobody', async () => {
        const anon = await file(null);
        // It exists on the privileged path...
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT COUNT(*)::bigint AS n FROM "ContentReport" WHERE "id" = $1`, anon.id,
        );
        expect(Number(rows[0].n)).toBe(1);
        // ...and matches no reporter, because `NULL = NULL` is NULL in SQL.
        // Checked for BOTH people, so this is not passing because one of them
        // happens to see nothing.
        for (const who of [REPORTER, OTHER]) {
            const seen = await listOwnReports(ctxFor(who));
            expect(seen.some((r) => r.id === anon.id)).toBe(false);
        }
    });

    it('a client-supplied reporterUserId is DROPPED, not honoured', async () => {
        // The body schema strips it and `fileNotice` takes the reporter as a
        // parameter, so there are two independent reasons this cannot work.
        // Asserted end-to-end rather than by reading the schema, because the
        // failure mode is a future refactor passing `input` straight through.
        const filed = await fileNotice(
            {
                subjectKind: 'LISTING',
                subjectId: `listing-${randomUUID()}`,
                reasonCode: 'SPAM',
                detail: null,
                // @ts-expect-error — deliberately sending a field the type
                // does not have, which is what a hostile client does.
                reporterUserId: OTHER,
            },
            REPORTER,
        );
        created.push(filed.id);
        const row = await globalPrisma.$queryRawUnsafe<Array<{ r: string | null }>>(
            `SELECT "reporterUserId" AS r FROM "ContentReport" WHERE "id" = $1`, filed.id,
        );
        expect(row[0].r).toBe(REPORTER);
    });

    describe('the snapshot', () => {
        it('is captured for every notice, on the platform-only table', async () => {
            const filed = await file(REPORTER);
            const rows = await globalPrisma.$queryRawUnsafe<
                Array<{ n: bigint; captureerror: string | null }>
            >(
                `SELECT COUNT(*)::bigint AS n, MIN("captureError") AS captureerror
                 FROM "ReportSnapshot" WHERE "reportId" = $1`, filed.id,
            );
            expect(Number(rows[0].n)).toBe(1);
            // The listing id is random, so capture correctly finds nothing and
            // says so. That IS the assertion: a notice about deleted content
            // still gets a row, with the reason, because Art 16 requires an
            // answer either way.
            expect(rows[0].captureerror).toBe('SUBJECT_NOT_FOUND');
        });

        it('records an UNCAPTURABLE subject kind distinctly from a missing one', async () => {
            // PROFILE has no surface until P6. "Nothing to capture" and
            // "nobody implemented this" must not read the same, or the queue
            // cannot tell a deleted listing from a gap in our own code.
            const filed = await file(REPORTER, { subjectKind: 'PROFILE' });
            const rows = await globalPrisma.$queryRawUnsafe<Array<{ e: string | null }>>(
                `SELECT "captureError" AS e FROM "ReportSnapshot" WHERE "reportId" = $1`,
                filed.id,
            );
            expect(rows[0].e).toBe('SUBJECT_KIND_NOT_CAPTURABLE');
        });

        it('is NOT reachable by the reporter — the reason it is its own table', async () => {
            // The retention argument that moved the snapshot off
            // `ContentReport`: the reporter arm is ROW-level, so a column
            // there would have handed a reporter a durable copy of a private
            // message after its author deleted it.
            //
            // `listOwnReports` is the reporter's whole view, so asserting the
            // snapshot is absent from its SHAPE is the honest check — a
            // separate query as `app_user` would be testing the policy again
            // rather than the product.
            const mine = await listOwnReports(ctxFor(REPORTER));
            expect(mine.length).toBeGreaterThan(0);
            for (const r of mine) {
                expect(Object.keys(r)).not.toContain('body');
                expect(Object.keys(r)).not.toContain('snapshot');
            }
        });
    });

    it('detail is SANITISED on the way in', async () => {
        const filed = await file(REPORTER, {
            detail: '<script>alert(1)</script>plain words',
        });
        const mine = await listOwnReports(ctxFor(REPORTER));
        const row = mine.find((r) => r.id === filed.id);
        expect(row).toBeDefined();
        expect(row!.detail).not.toContain('<script');
        expect(row!.detail).toContain('plain words');
    });

    it('detail that sanitises to NOTHING is stored as null, not as an empty string', async () => {
        // "They wrote only markup" and "they wrote nothing" are the same fact
        // to a moderator, and a column holding '' would make the queue render
        // an empty quote block.
        const filed = await file(REPORTER, { detail: '<b></b>' });
        const row = await globalPrisma.$queryRawUnsafe<Array<{ d: string | null }>>(
            `SELECT "detail" AS d FROM "ContentReport" WHERE "id" = $1`, filed.id,
        );
        expect(row[0].d).toBeNull();
    });
});
