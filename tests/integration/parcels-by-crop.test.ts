/**
 * Farm-wide parcels grouped by crop (DB-backed) — #1740 step 2.
 *
 * The read exists because parcels were only listable per BLOCK, so a client
 * wanting "every parcel of this crop" fanned out one request per block and
 * grouped them itself. Several properties are worth holding, and each is a
 * decision rather than an implementation detail:
 *
 *   1. A parcel with NO crop appears in neither answer. "No crop" does not
 *      answer "which crop did you treat".
 *   2. Matching is case-insensitive, because `Parcel.cropType` is a free
 *      string an import stamps and stored rows can disagree about case.
 *   3. An unknown crop is an EMPTY list, not a 404 — a crop is not an entity.
 *   4. Order is `name` then `id`. The tiebreak is contractual (#1391):
 *      parcel names are NOT unique, so without it a capped read can return a
 *      different subset between requests with nothing changed.
 *
 * Two blocks are used throughout, because the whole point is crossing them and
 * because `locationName` exists to tell apart two blocks that each hold a
 * field with the same name — which this fixture deliberately contains.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    listTenantCropTotals,
    listTenantParcelsByCrop,
} from '@/app-layer/usecases/parcel';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const TAG = `bycrop-${randomUUID().slice(0, 8)}`;

let userId = '';
let tenantId = '';
let blockA = '';
let blockB = '';

const ctx = () => makeRequestContext('OWNER', { userId, tenantId, tenantSlug: `${TAG}-t` });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.$connect();
    const email = `${TAG}@ag.test`;
    userId = (await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email), name: 'ByCrop User' },
    })).id;
    const tenant = await globalPrisma.tenant.create({ data: { name: `T ${TAG}`, slug: `${TAG}-t` } });
    tenantId = tenant.id;
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });

    blockA = (await globalPrisma.location.create({ data: { tenantId, name: `Block A ${TAG}` } })).id;
    blockB = (await globalPrisma.location.create({ data: { tenantId, name: `Block B ${TAG}` } })).id;

    // INSERTION ORDER IS DELIBERATELY NOT NAME ORDER. The first version of this
    // fixture created parcels '1','1','2',... in ascending name order, and
    // Postgres returned them in that physical order — so removing the ORDER BY
    // entirely still produced a sorted list and the ordering assertion could
    // not fail. Measured, not assumed: both the dropped-tiebreak and the
    // dropped-ORDER-BY mutations passed 6/6. Creating '2' first is what gives
    // the assertion something to catch.
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockA, name: '2', cropType: 'wheat', areaHa: 1 } });
    // Wheat across BOTH blocks, including the two identically-named fields
    // that make locationName load-bearing: same name, different block.
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockA, name: '1', cropType: 'Wheat', areaHa: 4 } });
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockB, name: '1', cropType: 'Wheat', areaHa: 6 } });
    // Another crop, so the totals have something to separate.
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockA, name: '3', cropType: 'Barley', areaHa: 2 } });
    // No crop at all, and a blank one — neither should surface anywhere.
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockA, name: '4', cropType: null, areaHa: 9 } });
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockA, name: '5', cropType: '   ', areaHa: 9 } });
    // Off-catalogue, as a spatial import would stamp it. Must be reported
    // verbatim rather than normalised away.
    await globalPrisma.parcel.create({ data: { tenantId, locationId: blockB, name: '6', cropType: 'Winter Wheat', areaHa: 3 } });
    // Soft-deleted, to prove the filter is on more than tenantId.
    await globalPrisma.parcel.create({
        data: { tenantId, locationId: blockA, name: '7', cropType: 'Wheat', areaHa: 100, deletedAt: new Date() },
    });
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        for (const tbl of ['Parcel', 'Location', 'AuditLog', 'TenantMembership']) {
            await globalPrisma.$executeRawUnsafe(`DELETE FROM "${tbl}" WHERE "tenantId" = $1`, tenantId).catch(() => {});
        }
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, tenantId).catch(() => {});
        await globalPrisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
    } catch { /* best-effort */ }
    await globalPrisma.$disconnect();
});

describeFn('parcels by crop (DB-backed)', () => {
    it('reports each stored crop verbatim, excluding no-crop and blank-crop parcels', async () => {
        const crops = await listTenantCropTotals(ctx());
        const byType = new Map(crops.map((c) => [c.cropType, c]));

        // 'wheat' and 'Wheat' are DISTINCT keys here, deliberately: this
        // reports what is stored, and the catalogue — not the repository —
        // owns the question of whether they are one crop.
        expect([...byType.keys()].sort()).toEqual(
            ['Barley', 'Winter Wheat', 'Wheat', 'wheat'].sort(),
        );

        // The soft-deleted 100 ha Wheat parcel is absent from both the count
        // and the area, which a tenantId-only filter would have included.
        expect(byType.get('Wheat')).toMatchObject({ parcelCount: 2, areaHaTotal: 10 });
        expect(byType.get('Barley')).toMatchObject({ parcelCount: 1, areaHaTotal: 2 });
        // Off-catalogue survives unchanged — never hidden, never renamed.
        expect(byType.get('Winter Wheat')).toMatchObject({ parcelCount: 1, areaHaTotal: 3 });
    });

    it('matches a crop case-insensitively and crosses blocks', async () => {
        const rows = await listTenantParcelsByCrop(ctx(), 'WHEAT');
        // Both 'Wheat' rows plus the 'wheat' one; the soft-deleted one never.
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.cropType).sort()).toEqual(['Wheat', 'Wheat', 'wheat']);
        expect(new Set(rows.map((r) => r.locationId)).size).toBe(2);
    });

    it('names the block, which is what tells two identically-named fields apart', async () => {
        const rows = await listTenantParcelsByCrop(ctx(), 'Wheat');
        const ones = rows.filter((r) => r.name === '1');
        expect(ones).toHaveLength(2);
        // Same field name, different block — so the block name is the only
        // thing distinguishing them to the person ticking boxes.
        expect(new Set(ones.map((r) => r.locationName)).size).toBe(2);
        expect(ones.every((r) => r.locationName.startsWith('Block '))).toBe(true);
    });

    it('orders by name, which an unordered read does not', async () => {
        const rows = await listTenantParcelsByCrop(ctx(), 'wheat');
        const names = rows.map((r) => r.name);
        expect(names).toEqual([...names].sort());
        // This catches a missing ORDER BY because the fixture inserts '2'
        // before the two '1's — see the note there.
        expect(names[0]).toBe('1');
    });

    it('asks for the id tiebreak in SQL, whose EFFECT this cannot reproduce', async () => {
        // Honest about what is and is not verified here. The tiebreak matters
        // when two parcels share a name: the id makes the order TOTAL rather
        // than mostly-stable (#1391). But reproducing a tie resolving the
        // wrong way needs the two rows' random ids to sort opposite to their
        // physical order, which is chance — so a runtime assertion on it
        // passes whether or not the tiebreak is there. Measured: removing
        // `, "Parcel"."id" ASC` left all cases green.
        //
        // So this asserts the MECHANISM, which is the part that is actually
        // checkable, and says plainly that the behaviour is not covered.
        const sql = readFileSync(
            join(__dirname, '..', '..', 'src/app-layer/repositories/ParcelRepository.ts'),
            'utf8',
        );
        expect(sql).toContain('ORDER BY "Parcel"."name" ASC, "Parcel"."id" ASC');
    });

    it('returns an empty list for a crop nobody grows, rather than refusing', async () => {
        await expect(listTenantParcelsByCrop(ctx(), 'Quinoa')).resolves.toEqual([]);
        // Blank is treated as "no crop asked for" rather than matching the
        // blank-cropType parcel, which must stay invisible.
        await expect(listTenantParcelsByCrop(ctx(), '   ')).resolves.toEqual([]);
    });

    it('reports hectares as stored, leaving the unit conversion to the caller', async () => {
        const rows = await listTenantParcelsByCrop(ctx(), 'Barley');
        expect(rows).toHaveLength(1);
        // 2 hectares, not 20 dekares — the conversion belongs where the number
        // is displayed, not in the read.
        expect(rows[0].areaHa).toBe(2);
    });
});
