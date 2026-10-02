/**
 * A swept model does not have to key on `id`.
 *
 * ── the defect ──
 *
 * Every sweep in `global-key-rotation.ts` built `SELECT id … ORDER BY id` and
 * `WHERE id = $2` directly. That held for every model in `GLOBAL_KEK_MODELS`
 * when it was written — `Tenant`, `Company`, `ExchangeMessage` all key on `id`.
 * `FeatureFlag` keys on `key`.
 *
 * Found by Agrent backend 1 when `FeatureFlag` entered that set in #1252: it
 * has no `tenantId` and holds a `v1:` row, so
 * `global-kek-models-covers-tenantless` requires it there — and the moment it
 * did, `repairMisplacedV2` died with 42703 for EVERY model, and the pre-flight
 * refused to sweep at all.
 *
 * The pre-flight refusing was the system working: it stopped before touching a
 * row and named the model. The defect is that its `noId` check encoded the
 * assumption as a REQUIREMENT ("every model must have `id`") rather than as a
 * question ("which column addresses this model's rows"), and three other call
 * sites assumed the same thing with no check at all.
 *
 * ── what this file proves, and what it does not ──
 *
 * It proves the MECHANISM against the real database schema: the pre-flight now
 * accepts a model whose declared row key exists, and still refuses one whose
 * row key cannot be resolved. The discriminating pair is the point — both cases
 * name the SAME TABLE and differ only in the model name, so the registry entry
 * is demonstrably what decides the outcome, not something about the table.
 *
 * It does NOT prove an end-to-end sweep of a non-`id` model, because on this
 * branch `FeatureFlag` is in neither manifest, so `sweepableColumns()` never
 * yields it and `SWEEP_ROW_KEY.FeatureFlag` is inert. That half belongs to
 * #1252, which adds the model and asserts `FeatureFlag.description` is PRESENT
 * in the swept set. Stated rather than papered over: a test cannot exercise a
 * registry entry for a model the manifest does not carry.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { assertSweepableColumns, sweepableColumns } from '@/app-layer/usecases/global-key-rotation';
import type { SweepableColumn } from '@/app-layer/usecases/global-key-rotation';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

/** A synthetic column, so the subject is the PRE-FLIGHT and not the manifest. */
function col(model: string, table: string, column: string): SweepableColumn {
    return { model, table, manifestName: column, column, manifest: 'encrypted-fields' };
}

describeFn('the pre-flight resolves a row key instead of demanding `id`', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
    });
    afterAll(async () => {
        await globalPrisma.$disconnect();
    });

    it('FeatureFlag really has no `id` column — the premise, measured', async () => {
        // Asserted against the live schema rather than read off the Prisma file,
        // because the pre-flight queries information_schema and that is the
        // thing that has to disagree with `id`.
        const rows = await globalPrisma.$queryRawUnsafe<Array<{ column_name: string }>>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'FeatureFlag'`,
        );
        const names = rows.map((r) => r.column_name);
        expect(names).toContain('key');
        expect(names).not.toContain('id');
    });

    it('ACCEPTS a model whose declared row key exists', async () => {
        await expect(
            assertSweepableColumns([col('FeatureFlag', 'FeatureFlag', 'description')]),
        ).resolves.toBeUndefined();
    });

    it('REFUSES the same table when the model has no registry entry', async () => {
        // The discriminating half. Identical table and column; only the model
        // name differs, so `SWEEP_ROW_KEY` falls back to `id`, which this table
        // does not have. If both cases passed, the first would prove nothing —
        // it would mean the check had simply stopped looking.
        await expect(
            assertSweepableColumns([col('NotInTheRegistry', 'FeatureFlag', 'description')]),
        ).rejects.toThrow(/unusable row keys/);
    });

    it('the refusal names the table AND the column it wanted', async () => {
        // A pre-flight that refuses without saying which model is a pre-flight
        // someone disables. This message is the whole reason the check is worth
        // having over a mid-sweep crash.
        await expect(
            assertSweepableColumns([col('NotInTheRegistry', 'FeatureFlag', 'description')]),
        ).rejects.toThrow(/FeatureFlag has no "id" column/);
    });

    it('still REFUSES a genuinely missing value column', async () => {
        // The other arm of the same throw, kept so generalising the row key did
        // not quietly remove the check that was already there.
        await expect(
            assertSweepableColumns([col('FeatureFlag', 'FeatureFlag', 'no_such_column')]),
        ).rejects.toThrow(/missing columns/);
    });

    it('the REAL manifest still passes — every swept model is addressable', async () => {
        // The regression guard for the live set. The generalisation must be
        // behaviour-preserving for the models already swept, all of which key
        // on `id`.
        const columns = sweepableColumns();
        expect(columns.length).toBeGreaterThan(0); // the denominator
        await expect(assertSweepableColumns(columns)).resolves.toBeUndefined();
    });

    it('NOTE: the text-type check has no live subject, and this cannot prove it', () => {
        // The pre-flight also refuses a row key that is not a text type, because
        // the keyset cursor binds it as a string parameter and an integer key
        // would page by text coercion — a sweep that stops early and reports
        // success.
        //
        // Every primary key in this schema is text (no `Int @id`, no `@@id([…])`
        // composite), so there is no table that can exercise that branch, and a
        // synthetic one would be testing a fixture rather than the product.
        // Recorded here instead of dressed up as an assertion: a test that
        // passes with the code deleted is worse than no test, because it reads
        // as cover. If a model ever arrives with an integer key, this is the
        // note that says the check is already waiting for it.
        expect(true).toBe(true);
    });
});
