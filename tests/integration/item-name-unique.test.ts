/**
 * One product name per tenant — the index, not the intention (#1078).
 *
 * `Item` carried `@@index([tenantId, name])`, an index rather than a
 * constraint, and nothing checked for an existing row. Production holds the
 * consequence: two rows both named `Roubdup`, created minutes apart, the only
 * real products anyone has entered. Sprays filed against both would split one
 * product's history across two ids with no way to tell from the register.
 *
 * Three properties need a real database, because all three live in raw SQL
 * that Prisma cannot express and therefore cannot typecheck:
 *
 *  • the index is CASE-INSENSITIVE — `Roundup` and `roundup` are the same
 *    accident as `Roubdup` twice;
 *  • it is PARTIAL — a soft-deleted name can be used again, or correcting a
 *    misspelling would reserve the typo forever;
 *  • it is PER TENANT — two farms may both stock the same product.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `inu-${randomUUID().slice(0, 8)}`;
let tenantA = '';
let tenantB = '';
let unitId = '';

async function mkItem(tenantId: string, name: string, deleted = false) {
    return prisma.item.create({
        data: {
            tenantId,
            name,
            category: 'PESTICIDE',
            defaultUnitId: unitId,
            deletedAt: deleted ? new Date() : null,
        },
        select: { id: true },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    const a = await prisma.tenant.create({ data: { name: `${TAG}-a`, slug: `${TAG}-a` } });
    const b = await prisma.tenant.create({ data: { name: `${TAG}-b`, slug: `${TAG}-b` } });
    tenantA = a.id;
    tenantB = b.id;
    const unit = await prisma.unit.findFirst({ select: { id: true } });
    unitId = unit!.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.item.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
});

describeFn('Item name uniqueness (DB)', () => {
    it('refuses a second live row with the same name', async () => {
        await mkItem(tenantA, 'Karate Zeon 5 CS');
        await expect(mkItem(tenantA, 'Karate Zeon 5 CS')).rejects.toMatchObject({ code: 'P2002' });
    });

    it('refuses a name differing only in CASE', async () => {
        // The accident the Roubdup pair is an instance of. A case-sensitive
        // index would have let `roundup` through beside `Roundup`.
        await mkItem(tenantA, 'Mancozeb 75 WP');
        await expect(mkItem(tenantA, 'MANCOZEB 75 wp')).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows the same name in a DIFFERENT tenant', async () => {
        // Positive control for the partition column. Without it the index
        // would be global and two farms could not both stock one product —
        // an assertion that the refusals above are not simply "no two items
        // may share a name anywhere".
        await mkItem(tenantB, 'Karate Zeon 5 CS');
        const n = await prisma.item.count({ where: { name: 'Karate Zeon 5 CS' } });
        expect(n).toBe(2);
    });

    it('allows reusing the name of a SOFT-DELETED row', async () => {
        // Why the index is partial. The row this feature retires is a
        // misspelling somebody will want to correct, and a total index would
        // reserve the typo permanently.
        const gone = await mkItem(tenantA, 'Retired Product');
        await prisma.item.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
        await expect(mkItem(tenantA, 'Retired Product')).resolves.toBeDefined();
    });

    it('still refuses once the name is revived', async () => {
        // Clearing `deletedAt` on a row whose name is now taken must fail —
        // otherwise "delete, re-create, undelete" is a way around the index.
        const first = await mkItem(tenantA, 'Revivable');
        await prisma.item.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
        await mkItem(tenantA, 'Revivable');
        await expect(
            prisma.item.update({ where: { id: first.id }, data: { deletedAt: null } }),
        ).rejects.toMatchObject({ code: 'P2002' });
    });
});

describeFn('the migration’s cleanup step', () => {
    /**
     * Runs the ACTUAL SQL from the migration file, not a copy of it. A
     * transcribed query drifts from the one that ships, and this is the
     * destructive half — it soft-deletes rows.
     */
    function cleanupSql(): string {
        const file = path.join(
            __dirname,
            '../../prisma/migrations/20260923150000_item_name_unique_per_tenant/migration.sql',
        );
        const sql = fs.readFileSync(file, 'utf8');
        const stmt = sql.split('CREATE UNIQUE INDEX')[0];
        const withCte = stmt.slice(stmt.indexOf('WITH ranked'));
        expect(withCte).toContain('UPDATE "Item"');
        return withCte;
    }

    /**
     * The duplicates this step exists to retire cannot be created any more —
     * the index it installs forbids them. So the test reproduces the
     * PRE-MIGRATION state the way the migration meets it: index absent.
     *
     * Everything happens inside a transaction that is rolled back, so the
     * dropped index is restored even if an assertion throws, and no row or
     * DDL survives into another test or another shard.
     */
    async function inPreMigrationState<T>(fn: (tx: typeof prisma) => Promise<T>): Promise<T> {
        const ROLLBACK = Symbol('rollback');
        try {
            return await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe('DROP INDEX "Item_tenantId_name_active_key"');
                const out = await fn(tx as unknown as typeof prisma);
                throw Object.assign(new Error('rollback'), { [ROLLBACK]: true, out });
            });
        } catch (e) {
            if ((e as Record<symbol, unknown>)[ROLLBACK]) return (e as { out: T }).out;
            throw e;
        }
    }

    it('retires the UNREFERENCED duplicate and keeps the referenced one', async () => {
        const out = await inPreMigrationState(async (tx) => {
            // The production shape exactly: two same-named rows, one carrying
            // a lot. The referenced one is created SECOND, so surviving proves
            // reference count outranks age rather than coinciding with it.
            const drop = await tx.item.create({
                data: { tenantId: tenantB, name: 'Dupe Target', category: 'PESTICIDE', defaultUnitId: unitId },
                select: { id: true },
            });
            const keep = await tx.item.create({
                data: { tenantId: tenantB, name: 'Dupe Target', category: 'PESTICIDE', defaultUnitId: unitId },
                select: { id: true },
            });
            await tx.inventoryLot.create({
                data: { tenantId: tenantB, itemId: keep.id, lotCode: `${TAG}-lot`, quantityOnHand: 0, unitId },
            });

            await tx.$executeRawUnsafe(cleanupSql());

            const rows = await tx.item.findMany({
                where: { id: { in: [keep.id, drop.id] } },
                select: { id: true, deletedAt: true },
            });
            const byId = new Map(rows.map((r) => [r.id, r.deletedAt]));
            return { keep: byId.get(keep.id) ?? null, drop: byId.get(drop.id) ?? null };
        });
        // The referenced row survives despite being NEWER — so the cleanup can
        // never detach a lot, a spray line or a cost entry from its product.
        expect(out.keep).toBeNull();
        expect(out.drop).not.toBeNull();
    });

    it('leaves a non-duplicated row alone', async () => {
        const out = await inPreMigrationState(async (tx) => {
            const solo = await tx.item.create({
                data: { tenantId: tenantB, name: 'Unique Product', category: 'PESTICIDE', defaultUnitId: unitId },
                select: { id: true },
            });
            await tx.$executeRawUnsafe(cleanupSql());
            const row = await tx.item.findUnique({ where: { id: solo.id }, select: { deletedAt: true } });
            return row?.deletedAt ?? null;
        });
        expect(out).toBeNull();
    });

    it('the index is back afterwards (the rollback actually rolled back)', async () => {
        // Without this the two tests above could pass while leaving the
        // database permanently unconstrained for every later test.
        const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
            `SELECT indexname FROM pg_indexes WHERE indexname = 'Item_tenantId_name_active_key'`,
        );
        expect(rows).toHaveLength(1);
    });
});
