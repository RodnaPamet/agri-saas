/**
 * Tenant isolation on the parcel-overview RAW query — DB-backed.
 *
 * This is the test that matters for this feature. `listForOverview` is
 * `$queryRaw`, and raw SQL bypasses Prisma's `tenantId` filtering
 * completely: the ORM cannot help here, so isolation rests on (a) the
 * explicit `"tenantId" = ...` predicate in the SQL and (b) Postgres RLS.
 * Both are asserted BEHAVIOURALLY below rather than by checking a policy
 * exists somewhere.
 *
 * The failure this guards against is the worst kind available in a
 * multi-tenant product: one farm seeing another farm's field positions
 * on a map. Coordinates are not an abstract leak — they are where
 * someone's crop physically is.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { getParcelOverview } from '@/app-layer/usecases/parcel-overview';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = randomUUID().slice(0, 8);
const TENANT_A = `t-a-${TAG}`;
const TENANT_B = `t-b-${TAG}`;
let locationA = '';
let locationB = '';

/**
 * ALWAYS-RUNNING execution status. A skipped suite is indistinguishable
 * from a passing one, and a run gets *greener* by running less — so when
 * this cannot reach a database it says so loudly instead of quietly
 * contributing nothing. (CLAUDE.md, "Green is not the same as executed".)
 */
describe('parcel-overview isolation — execution status', () => {
    it('reports whether the DB-backed assertions actually ran', () => {
        if (!DB_AVAILABLE) {
            // eslint-disable-next-line no-console
            console.warn(
                '\n[parcel-overview-isolation] SKIPPED — no database reachable.\n' +
                '  NOT verified: that the raw parcel-overview query refuses to\n' +
                '  return another tenant\'s parcel coordinates. Raw SQL bypasses\n' +
                '  Prisma tenant filtering, so this is the assertion that matters.\n' +
                '  Set RLS_GUARDRAIL_REQUIRE_DB=1 in an environment that guarantees\n' +
                '  a database to make this a hard failure.\n',
            );
        }
        if (process.env.RLS_GUARDRAIL_REQUIRE_DB === '1') {
            expect(DB_AVAILABLE).toBe(true);
        }
        expect(true).toBe(true);
    });
});

describeFn('parcel-overview raw query — tenant isolation', () => {
    beforeAll(async () => {
        for (const id of [TENANT_A, TENANT_B]) {
            await globalPrisma.tenant.create({
                data: { id, name: `Tenant ${id}`, slug: id },
            });
        }
        const la = await globalPrisma.location.create({
            data: { tenantId: TENANT_A, name: `Loc A ${TAG}` },
        });
        const lb = await globalPrisma.location.create({
            data: { tenantId: TENANT_B, name: `Loc B ${TAG}` },
        });
        locationA = la.id;
        locationB = lb.id;

        // One parcel each. Geometry is Unsupported, so it goes in raw —
        // a real MultiPolygon so ST_PointOnSurface has something to sit on.
        for (const [tenantId, locationId, lon] of [
            [TENANT_A, locationA, 26.6] as const,
            [TENANT_B, locationB, 27.6] as const,
        ]) {
            const pid = randomUUID();
            await globalPrisma.$executeRawUnsafe(
                `INSERT INTO "Parcel" ("id","tenantId","locationId","name","areaHa","geometry","createdAt","updatedAt")
                 VALUES ($1,$2,$3,$4,$5,
                   ST_Multi(ST_SetSRID(ST_GeomFromText($6), 4326)), NOW(), NOW())`,
                pid, tenantId, locationId, `Parcel ${tenantId}`, 5,
                `POLYGON((${lon} 43.1, ${lon + 0.01} 43.1, ${lon + 0.01} 43.11, ${lon} 43.11, ${lon} 43.1))`,
            );
        }
    });

    afterAll(async () => {
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "Parcel" WHERE "tenantId" IN ($1,$2)`, TENANT_A, TENANT_B,
        );
        await globalPrisma.location.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await globalPrisma.$disconnect();
    });

    it('returns tenant A its own parcel', () => {
        // Sanity: without this, the isolation assertions below could pass
        // simply because the query returns nothing to anyone.
        const ctxA = makeRequestContext('READER', { tenantId: TENANT_A });
        return expect(getParcelOverview(ctxA, locationA)).resolves.toMatchObject({
            positionedCount: 1,
        });
    });

    it('refuses tenant A access to tenant B\'s location', async () => {
        // The core assertion: A asking for B's locationId gets NOTHING —
        // not B's coordinates, not a partial answer.
        const ctxA = makeRequestContext('READER', { tenantId: TENANT_A });
        const overview = await getParcelOverview(ctxA, locationB);
        expect(overview.positionedCount).toBe(0);
        expect(overview.clusters).toEqual([]);
        expect(overview.unpositionedCount).toBe(0);
    });

    it('leaks no coordinates across the boundary', async () => {
        // Belt and braces on the one thing that actually matters: B's
        // parcels sit near lon 27.6, A's near 26.6. Nothing in A's
        // payload may carry B's longitude.
        const ctxA = makeRequestContext('READER', { tenantId: TENANT_A });
        const own = await getParcelOverview(ctxA, locationA);
        for (const c of own.clusters) {
            expect(c.lon).toBeLessThan(27);
        }
    });

    it('is symmetric — B cannot read A either', async () => {
        const ctxB = makeRequestContext('READER', { tenantId: TENANT_B });
        const overview = await getParcelOverview(ctxB, locationA);
        expect(overview.positionedCount).toBe(0);
    });
});
