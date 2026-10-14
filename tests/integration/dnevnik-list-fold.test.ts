/**
 * The ДНЕВНИК list folds one row per treatment, and PAGES correctly (#1740).
 *
 * A treatment writes one `INPUT_APPLICATION` entry per line, and the register
 * shows one row. The fold is `distinct: ['treatmentGroupId']` inside the
 * query, because collapsing after `take: limit + 1` would shrink the page and
 * make `hasNextPage` wrong.
 *
 * ## The assertion this file exists for
 *
 * Paging must emit each treatment EXACTLY once. The first implementation used
 * the shared `(createdAt, id)` cursor, and that cannot skip a folded group:
 * `DISTINCT ON` picks the first member, the cursor excludes only that row, and
 * the group's older members represent it again on the next page. Measured
 * before the fix — 3 treatments of 3 entries, paged 2 at a time, returned SIX
 * rows with one treatment three times. For a compliance register a farmer
 * would reasonably read a repeated treatment as a repeated application.
 *
 * So the test walks the cursor to exhaustion rather than checking one page.
 * A single-page assertion passes on the broken implementation.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { recordDiaryTreatment } from '@/app-layer/usecases/diary-treatment';
import { listLogEntriesPaginated } from '@/app-layer/usecases/journal';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `fold-${randomUUID().slice(0, 8)}`;

let userId = '';
let tenantId = '';
let unitId = '';
let itemId = '';
let blockA = '';
let blockB = '';
const parcels: string[] = [];
/** Three treatments, three different days — newest LAST so order is a fact. */
const DAYS = ['2026-03-01', '2026-03-05', '2026-03-09'];
const handles = DAYS.map((d) => `${TAG}-${d}`);

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'Fold User' },
    })).id;
    unitId = (await globalPrisma.unit.create({
        data: { key: `l-ha-${TAG}`, name: 'L/ha', symbol: 'L/ha', measure: 'RATE' },
    })).id;
    tenantId = (await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } })).id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    blockA = (await globalPrisma.location.create({ data: { tenantId, name: `Блок А ${TAG}` } })).id;
    blockB = (await globalPrisma.location.create({ data: { tenantId, name: `Блок Б ${TAG}` } })).id;
    for (const [loc, name, area] of [[blockA, 'A1', 4], [blockA, 'A2', 6], [blockB, 'B1', 10]] as const) {
        parcels.push(
            (await globalPrisma.parcel.create({
                data: { tenantId, locationId: loc, name: `${name} ${TAG}`, cropType: 'Wheat', areaHa: area },
            })).id,
        );
    }
    itemId = (await globalPrisma.item.create({
        data: {
            tenantId, name: `ПРЗ ${TAG}`, category: 'PESTICIDE', defaultUnitId: unitId,
            quarantinePeriodDays: 30,
        },
    })).id;

    // Three treatments, each over all three parcels across both blocks — so
    // each is 3 entries and must fold to 1 row.
    for (let i = 0; i < DAYS.length; i++) {
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SPRAY', occurredOn: DAYS[i], parcelIds: [...parcels],
                productItemId: itemId, doseValue: 2, doseUnitId: unitId,
                targetNote: 'Септория', applicationTechnique: 'boom-sprayer',
                quarantinePeriodDays: 7,
            },
            handles[i],
        );
    }
    // A manual entry, which belongs to no treatment and must fold to ITSELF.
    await globalPrisma.logEntry.create({
        data: {
            tenantId, type: 'OBSERVATION', title: `Наблюдение ${TAG}`,
            occurredAt: new Date('2026-03-07T00:00:00.000Z'), createdByUserId: userId,
        },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['StockTransaction', 'InventoryLot', 'LogQuantity', 'LogEntry', 'Notification', 'EmailOutbox', 'OperationParcel', 'TaskLink', 'Task', 'Item', 'Parcel', 'Location', 'AuditLog', 'AutomationExecution', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Unit" WHERE "id" = $1`, unitId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

type Row = { id: string; type: string; status: string; treatmentGroupId: string; treatment: Record<string, unknown> | null };

/** Walk the cursor to exhaustion. A single-page check passes on the bug. */
async function walk(limit: number): Promise<Row[]> {
    const all: Row[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
        const res = (await listLogEntriesPaginated(ctx(), { limit, cursor })) as {
            items: Row[];
            pageInfo: { nextCursor?: string; hasNextPage: boolean };
        };
        all.push(...res.items);
        if (!res.pageInfo.hasNextPage || !res.pageInfo.nextCursor) break;
        cursor = res.pageInfo.nextCursor;
    }
    return all;
}

describeFn('ДНЕВНИК list fold (DB-backed)', () => {
    it('folds 9 treatment entries plus a manual one into 4 rows', async () => {
        const entries = await globalPrisma.logEntry.count({ where: { tenantId, deletedAt: null } });
        expect(entries).toBe(10); // 3 treatments x 3 lines, plus 1 observation

        const rows = await walk(50);
        expect(rows).toHaveLength(4);
    });

    it('emits each treatment EXACTLY once across pages, and skips none', async () => {
        // THE load-bearing case, at a limit that forces page boundaries
        // inside the set. Under the old row cursor this returned 6+ rows with
        // treatments repeating.
        const rows = await walk(2);
        const groups = rows.map((r) => r.treatmentGroupId);

        expect(groups).toHaveLength(new Set(groups).size);
        for (const h of handles) expect(groups).toContain(h);
        expect(rows).toHaveLength(4);
    });

    it('orders by the day the work happened, newest first', async () => {
        const rows = await walk(2);
        const days = rows.map((r) => (r.treatment?.occurredOn as string) ?? null);
        // 09 Mar, 07 Mar (the manual entry), 05 Mar, 01 Mar.
        expect(days).toEqual(['2026-03-09', '2026-03-07', '2026-03-05', '2026-03-01']);
    });

    it('keeps the row ENTRY-SHAPED, so an old build still decodes it', async () => {
        const rows = await walk(50);
        for (const r of rows) {
            expect(typeof r.id).toBe('string');
            expect(typeof r.type).toBe('string');
            expect(typeof r.status).toBe('string');
        }
        // And the id is a REAL entry the detail read answers, not a synthetic
        // row id — an old build's tap must open something.
        const ids = rows.map((r) => r.id);
        const found = await globalPrisma.logEntry.count({ where: { tenantId, id: { in: ids } } });
        expect(found).toBe(rows.length);
    });

    it('carries the aggregate a farmer reads, across both blocks', async () => {
        const rows = await walk(50);
        const t = rows.find((r) => r.treatmentGroupId === handles[2])!.treatment!;
        expect(t.parcelCount).toBe(3);
        // 4 + 6 + 10 hectares, summed over the treatment rather than the row.
        expect(t.totalAreaHa).toBe(20);
        expect(t.blockNames).toEqual([`Блок А ${TAG}`, `Блок Б ${TAG}`]);
        expect(t.productName).toBe(`ПРЗ ${TAG}`);
        expect(t.doseUnit).toBe('L/ha');
        expect(t.targetNote).toBe('Септория');
    });

    it('computes earliest-harvest from the period captured ON THE DAY', async () => {
        // The line stored 7, the product says 30. The register must use 7 —
        // the same resolution the PDF uses (#1775), or the list and the
        // document disagree about the same number.
        const rows = await walk(50);
        const t = rows.find((r) => r.treatmentGroupId === handles[0])!.treatment!;
        expect(t.quarantinePeriodDays).toBe(7);
        expect(t.earliestHarvestOn).toBe('2026-03-08'); // 1 Mar + 7 days
    });

    it('reports a free-hand entry\'s day in the FARM zone, not sliced from UTC', async () => {
        // Finding 2 from agrent-ios's review. `occurredOn` was
        // `occurredAt.toISOString().slice(0, 10)`, justified as "reading back
        // the stored UTC midnight" — true of a TREATMENT entry, whose day is
        // written as `Date.UTC(y, mo, d)`, and FALSE of a free-hand entry,
        // whose `occurredAt` is a real instant.
        //
        // 22:30 UTC on 11 March IS 00:30 on 12 March in Sofia. The old slice
        // reported the 11th — the previous day — for anything a farmer typed
        // between local midnight and 03:00. Same UTC-slice-of-an-instant
        // mistake as the date guard they caught earlier on this issue.
        await globalPrisma.logEntry.create({
            data: {
                tenantId, type: 'OBSERVATION', title: `Късна бележка ${TAG}`,
                occurredAt: new Date('2026-03-11T22:30:00.000Z'),
                createdByUserId: userId,
            },
        });

        const rows = await walk(50);
        const late = rows.find((r) => (r.treatment?.occurredOn as string) === '2026-03-12');
        expect(late).toBeDefined();
        // And emphatically NOT the 11th.
        expect(rows.map((r) => r.treatment?.occurredOn)).not.toContain('2026-03-11');
    });

    it('keeps a treatment\'s own day stable under the same conversion', async () => {
        // The other half: the farm-zone conversion must not MOVE a treatment's
        // day. Its `occurredAt` is UTC midnight, which renders as the same
        // calendar day in Sofia (02:00 or 03:00) — asserted rather than
        // assumed, because a conversion that fixed the free-hand case by
        // shifting the treatment case would be a worse trade.
        const rows = await walk(50);
        for (let i = 0; i < DAYS.length; i++) {
            const row = rows.find((r) => r.treatmentGroupId === handles[i])!;
            expect(row.treatment!.occurredOn).toBe(DAYS[i]);
        }
    });

    it('aggregates EXACTLY and per group, with groups of different sizes', async () => {
        // Finding 1. The aggregate was a `findMany` with `take: 2000` over the
        // page's entries across ALL its groups, unordered — so a big page
        // returned arbitrary groups PARTIAL, with counts and areas too small
        // and nothing saying so. It is a GROUP BY now, which is bounded by the
        // page size rather than by the parcels behind it.
        //
        // Sizes differ deliberately: a cross-group sum, or a count taken from
        // one group and applied to all, would show up as equal figures here.
        const smallKey = `${TAG}-small`;
        await recordDiaryTreatment(
            ctx(),
            {
                kind: 'SPRAY', occurredOn: '2026-03-03', parcelIds: [parcels[0]],
                productItemId: itemId, doseValue: 2, doseUnitId: unitId,
            },
            smallKey,
        );

        const rows = await walk(50);
        const small = rows.find((r) => r.treatmentGroupId === smallKey)!.treatment!;
        const big = rows.find((r) => r.treatmentGroupId === handles[0])!.treatment!;

        // One parcel, 4 ha, one block.
        expect(small.parcelCount).toBe(1);
        expect(small.totalAreaHa).toBe(4);
        expect(small.blockNames).toEqual([`Блок А ${TAG}`]);
        // Three parcels, 20 ha, both blocks — and NOT the same as the small one.
        expect(big.parcelCount).toBe(3);
        expect(big.totalAreaHa).toBe(20);
        expect(big.blockNames).toHaveLength(2);
    });

    it('gives the manual entry its own row with no treatment detail', async () => {
        const rows = await walk(50);
        const manual = rows.find((r) => r.type === 'OBSERVATION')!;
        expect(manual).toBeDefined();
        // It folds to itself, so it is one row — and its `treatment` carries
        // no lines, because there are none.
        expect((manual.treatment as Record<string, unknown>).parcelCount).toBe(0);
    });
});
