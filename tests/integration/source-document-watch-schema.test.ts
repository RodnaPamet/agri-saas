/**
 * #3146 — the two facts about `SourceDocumentWatch` that only a real database
 * can establish, and that the job's unit test is structurally blind to.
 *
 * The unit suite drives an in-memory store, so it proves the job's logic and
 * says nothing about whether Postgres would accept what the job writes. These
 * three do:
 *
 *   1. `source_document_watch_flag_is_complete` refuses a PARTIAL flag.
 *      That constraint is load-bearing rather than tidy: a row with
 *      `changedAt` set and `changedSha256` null reads as "changed, hash
 *      unknown", and the job compares against that column on its next run —
 *      so the partial state would re-flag the document every day for ever.
 *   2. The unique index on `url` refuses a second row for one document, which
 *      is what stops one revision being reported as two.
 *   3. The table carries NO row-level security, which is what the migration
 *      CLAIMS and what the tenantless posture requires. Asserted rather than
 *      assumed, because a future auto-enroller change that swept this table
 *      into TENANT_SCOPED_MODELS would make every read return zero rows with
 *      no error — and a watch that silently sees nothing reports `clean`.
 *
 * Every negative is paired with the same operation by a row that should be
 * accepted. A suite of only-negatives passes identically when the table
 * refuses everything, which is the positive-control rule P8.1 paid for.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

let seq = 0;
/** A distinct URL per row, so cases cannot collide on the unique index. */
const url = () => `https://www.mzh.government.bg/t/${process.pid}-${++seq}.pdf`;

function baseline(over: Record<string, unknown> = {}) {
    return {
        url: url(),
        citation: 'mzh-oa-2026-09-02',
        publisher: 'МЗХ',
        series: 'operativen-analiz',
        sha256: 'a'.repeat(64),
        bytes: 1234,
        ...over,
    };
}

describeFn('SourceDocumentWatch — schema-level guarantees', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('CONTROL — a complete baseline row with NO flag inserts', async () => {
        const row = await prisma.sourceDocumentWatch.create({ data: baseline() });
        expect(row.changedAt).toBeNull();
        expect(row.firstSeenAt).toBeInstanceOf(Date);
    });

    it('CONTROL — a COMPLETE flag inserts, so the CHECK is not refusing everything', async () => {
        const row = await prisma.sourceDocumentWatch.create({
            data: baseline({
                changedAt: new Date(),
                changedSha256: 'b'.repeat(64),
                changedBytes: 99,
            }),
        });
        expect(row.changedSha256).toBe('b'.repeat(64));
    });

    it.each([
        ['changedAt alone', { changedAt: new Date() }],
        ['changedAt + hash, no bytes', { changedAt: new Date(), changedSha256: 'c'.repeat(64) }],
        ['a hash with no changedAt', { changedSha256: 'c'.repeat(64), changedBytes: 1 }],
        ['bytes with no changedAt', { changedBytes: 7 }],
    ])('refuses a partial flag: %s', async (_name, partial) => {
        // The SQLSTATE lives in the MESSAGE, not in `err.meta.code` — Prisma
        // wraps a raw constraint failure and `meta` carries no code, which is
        // the instrument error `p5-1-trust-safety-rls` records. Matching on
        // the constraint NAME is what makes this assert the right constraint
        // rather than any failure at all.
        await expect(
            prisma.sourceDocumentWatch.create({ data: baseline(partial) }),
        ).rejects.toThrow(/source_document_watch_flag_is_complete/);
    });

    it('refuses a SECOND row for the same document', async () => {
        const u = url();
        await prisma.sourceDocumentWatch.create({ data: baseline({ url: u }) });
        await expect(
            prisma.sourceDocumentWatch.create({ data: baseline({ url: u }) }),
        ).rejects.toThrow();

        const rows = await prisma.sourceDocumentWatch.findMany({ where: { url: u } });
        expect(rows).toHaveLength(1);
    });

    it('carries NO row-level security, matching the tenantless posture', async () => {
        const [{ relrowsecurity, relforcerowsecurity }] = await prisma.$queryRawUnsafe<
            { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >(`SELECT relrowsecurity, relforcerowsecurity
             FROM pg_class WHERE relname = 'SourceDocumentWatch'`);
        expect(relrowsecurity).toBe(false);
        expect(relforcerowsecurity).toBe(false);

        // CONTROL — the probe can see a table that DOES have RLS, so a
        // `false` above is an answer about this table rather than a query
        // that matched nothing or a column that stopped existing.
        const [tenantScoped] = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean }[]>(
            `SELECT relrowsecurity FROM pg_class WHERE relname = 'UserSession'`,
        );
        expect(tenantScoped.relrowsecurity).toBe(true);
    });
});
