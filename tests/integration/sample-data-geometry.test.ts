/**
 * Sample data can actually draw a map.
 *
 * The sample location shipped three parcels and ZERO geometry — deliberately,
 * because `createParcel` demands real PostGIS geometry and the generator writes
 * rows directly. The cost only showed up on a client: no geometry means no
 * `boundsJson`, so the native app fell through to its no-data camera and framed
 * the whole planet, and the schematic map, the parcel tap and the whole
 * vegetation-index overlay had nothing to render. A demo dataset that cannot
 * demonstrate three of the product's features reads as broken, not as empty.
 *
 * These assertions execute against a real database because every claim here is
 * PostGIS's to make: that the polygons parse, that they are valid, that the
 * stored `areaHa` matches the shape, and that the bounds are derived rather
 * than asserted. A mocked test can only prove the calls were made — which the
 * unit test already does, and which would stay green against a polygon PostGIS
 * rejects.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { loadSampleData } from '@/app-layer/usecases/sample-data';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `sdg-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';

/** Bulgaria's extent, generously. A polygon outside it is a coordinate bug. */
const BG = { west: 22.3, south: 41.2, east: 28.7, north: 44.3 };

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await prisma.$connect();
    await prisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: TENANT_ID, slug: TAG },
    });
    const email = `${TAG}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ownerId = u.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: ownerId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    await loadSampleData(
        makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG }),
    );
});

afterAll(async () => {
    if (!DB_AVAILABLE) return;
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            for (const t of ['Planting', 'CropPlan', 'Season', 'CropType', 'LogEntry',
                             'InventoryLot', 'Parcel', 'Location']) {
                await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, TENANT_ID);
            }
        });
    } catch {
        /* globalSetup handles reset */
    }
    await prisma.$disconnect();
});

describeFn('sample data carries drawable geometry (DB)', () => {
    it('every sample parcel has VALID geometry', async () => {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ name: string; valid: boolean | null; area_ha: number | null }>
        >(
            `SELECT p."name",
                    ST_IsValid(p."geometry") AS valid,
                    ST_Area(p."geometry"::geography) / 10000 AS area_ha
             FROM "Parcel" p WHERE p."tenantId" = $1 ORDER BY p."name"`,
            TENANT_ID,
        );

        // Positive control: the parcels exist. Every assertion below is over
        // this set, and an empty set satisfies all of them.
        expect(rows.length).toBeGreaterThanOrEqual(3);

        for (const r of rows) {
            expect(r.valid).toBe(true);
            expect(Number(r.area_ha)).toBeGreaterThan(0);
        }
    });

    it('the parcels total ~12 ha, matching the planting the calculator prices', async () => {
        // `SAMPLE_AREA_M2` declares a 12 ha planting and the sample's 60 t
        // standing crop is 12 ha x 5 t/ha. Parcels of another size would make
        // the dataset contradict its own arithmetic on the calculator screen.
        const [row] = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
            `SELECT COALESCE(SUM(ST_Area("geometry"::geography)), 0) / 10000 AS total
             FROM "Parcel" WHERE "tenantId" = $1`,
            TENANT_ID,
        );
        expect(Number(row.total)).toBeGreaterThan(11);
        expect(Number(row.total)).toBeLessThan(13);
    });

    it('stored areaHa matches the polygon rather than a hand-written number', async () => {
        // `areaHa` is written by PostGIS from the geometry. If someone later
        // sets it alongside the polygon instead, this catches the drift.
        const rows = await prisma.$queryRawUnsafe<Array<{ stored: number; computed: number }>>(
            `SELECT "areaHa"::float8 AS stored,
                    (ST_Area("geometry"::geography) / 10000)::float8 AS computed
             FROM "Parcel" WHERE "tenantId" = $1 AND "geometry" IS NOT NULL`,
            TENANT_ID,
        );
        expect(rows.length).toBeGreaterThanOrEqual(3);
        for (const r of rows) {
            expect(Math.abs(Number(r.stored) - Number(r.computed))).toBeLessThan(0.01);
        }
    });

    it('the location gets bounds, inside Bulgaria', async () => {
        const loc = await prisma.location.findFirst({
            where: { tenantId: TENANT_ID, isSampleData: true },
            select: { boundsJson: true },
        });
        expect(loc).not.toBeNull();

        const bounds = loc!.boundsJson as unknown as [number, number, number, number];
        expect(Array.isArray(bounds)).toBe(true);
        expect(bounds).toHaveLength(4);

        const [w, s, e, n] = bounds.map(Number);
        // Ordering: [west, south, east, north] — the shape `weather-pull` and
        // MapCanvas both read. A transposed pair passes a length check and
        // frames the wrong place.
        expect(w).toBeLessThan(e);
        expect(s).toBeLessThan(n);
        expect(w).toBeGreaterThan(BG.west);
        expect(e).toBeLessThan(BG.east);
        expect(s).toBeGreaterThan(BG.south);
        expect(n).toBeLessThan(BG.north);
    });
});
