/**
 * Part B (PR2) — КАИС cadastre import job, DB-backed integration.
 *
 * Exercises `runCadastreImport` WITHOUT hitting КАИС: a fresh `CadastreArchive`
 * cache row + the fixture ZIP staged in storage means `resolveArchive` reads the
 * cache and never constructs a live request. The fixture has 2 land-parcel
 * features (CADNUM `12345.10.1` / `12345.10.2`) plus an owner column; the import
 * requests one present + one missing identifier and asserts:
 *   • only the requested-and-present feature is imported (selection),
 *   • the missing identifier is reported in `notFound`,
 *   • the owner column is STRIPPED from persisted properties (privacy),
 *   • geometry lands as valid WGS84 inside Bulgaria (7801 reprojection).
 */
process.env.STORAGE_PROVIDER = 'local';
process.env.CADASTRE_OPENDATA_INDEX_URL = 'https://kais.example.test';

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { registerEncryptionMiddleware } from '@/lib/db/encryption-middleware';
import { prisma } from '@/lib/prisma';
import { getStorageProvider } from '@/lib/storage';
import { runCadastreImport } from '@/app-layer/jobs/cadastre-import';
import { listLocationParcels } from '@/app-layer/usecases/location';
import { buildCadastreShapefileZip, PRJ_WKT_7801 } from '../helpers/shapefile-fixture';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `cadastre-import-test-${Date.now()}`,
        userId,
        tenantId,
        role: 'EDITOR',
        permissions: computePermissions('EDITOR'),
        appPermissions: getPermissionsForRole('EDITOR'),
    };
}

jest.setTimeout(40_000);

describeFn('Part B — КАИС cadastre import job (cache-seeded)', () => {
    let testPrisma: PrismaClient;
    let tenantId = '';
    let editorId = '';
    let locationId = '';
    const slugs: string[] = [];
    const emails: string[] = [];
    const EKATTE = '12345';

    async function toSridRing(ring: Array<[number, number]>, srid: number): Promise<Array<[number, number]>> {
        const out: Array<[number, number]> = [];
        for (const [lon, lat] of ring) {
            const rows = await testPrisma.$queryRawUnsafe<Array<{ x: number; y: number }>>(
                `SELECT ST_X(g) AS x, ST_Y(g) AS y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326), ${srid}) AS g) s`,
            );
            out.push([Number(rows[0].x), Number(rows[0].y)]);
        }
        return out;
    }

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);
        const suffix = `cadimport-${Date.now()}`;
        const slug = `${suffix}-t`;
        slugs.push(slug);
        const t = await createTenantWithDek({ name: 'Import', slug });
        tenantId = t.id;
        const email = `${suffix}-editor@example.com`;
        emails.push(email);
        const editor = await testPrisma.user.create({ data: { email, name: 'Editor' } });
        editorId = editor.id;
        await testPrisma.tenantMembership.create({
            data: { userId: editorId, tenantId, role: 'EDITOR', status: 'ACTIVE' },
        });
        const loc = await testPrisma.location.create({ data: { tenantId, name: 'Import Farm' } });
        locationId = loc.id;

        // Build a 2-feature 7801 fixture (central Bulgaria) with an owner column.
        const sq = (dx: number): Array<[number, number]> => {
            const lon = 25.5 + dx, lat = 42.7;
            return [[lon, lat], [lon + 0.002, lat], [lon + 0.002, lat + 0.0018], [lon, lat + 0.0018], [lon, lat]];
        };
        const f1 = await toSridRing(sq(0), 7801);
        const f2 = await toSridRing(sq(0.01), 7801);
        const zip = await buildCadastreShapefileZip({
            features: [
                { ring: f1, cadnum: `${EKATTE}.10.1`, extra: { SOBSTVENIK: 'Ivan Petrov' } },
                { ring: f2, cadnum: `${EKATTE}.10.2`, extra: { SOBSTVENIK: 'Maria G' } },
            ],
            prjWkt: PRJ_WKT_7801,
            extraFields: [{ name: 'SOBSTVENIK', length: 20 }],
        });

        // Seed the GLOBAL cache: stage the ZIP + a fresh CadastreArchive row so
        // the job reads it instead of hitting КАИС.
        const storage = getStorageProvider();
        const storageKey = `cadastre-opendata/${EKATTE}/test-${Date.now()}.zip`;
        const wr = await storage.write(storageKey, zip, { mimeType: 'application/zip' });
        // `CadastreArchive.ekatte` is UNIQUE and the table is GLOBAL (no
        // tenantId), so `resetDatabase`'s tenant-scoped truncation never
        // touches it. The afterAll below deletes the row, but it deletes
        // several things inside ONE try/catch — an earlier statement throwing
        // skips the rest — and a run that crashes outright never reaches it at
        // all. Either way the next run collided on this create and the suite
        // failed for a reason that had nothing to do with what it tests.
        //
        // Self-healing setup rather than trusted teardown: a test that only
        // passes on a pristine database is a test that fails eventually.
        await testPrisma.cadastreArchive.deleteMany({ where: { ekatte: EKATTE } });
        await testPrisma.cadastreArchive.create({
            data: {
                ekatte: EKATTE,
                sourceDate: new Date(),
                storageKey,
                sizeBytes: wr.sizeBytes,
                sourcePath: 'test/поземлени имоти.zip',
                fetchedAt: new Date(),
            },
        });
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        try {
            await testPrisma.parcel.deleteMany({ where: { tenantId } });
            await testPrisma.location.updateMany({ where: { tenantId }, data: { spatialFileId: null } });
            await testPrisma.location.deleteMany({ where: { tenantId } });
            await testPrisma.fileRecord.deleteMany({ where: { tenantId } });
            await testPrisma.tenantMembership.deleteMany({ where: { tenantId } });
            await testPrisma.tenant.deleteMany({ where: { slug: { in: slugs } } });
            await testPrisma.user.deleteMany({ where: { email: { in: emails } } });
            await testPrisma.cadastreArchive.deleteMany({ where: { ekatte: EKATTE } });
        } catch {
            /* best effort */
        }
        await testPrisma.$disconnect();
    });

    test('imports the requested-present feature, reports the missing one, strips owner data', async () => {
        const result = await runCadastreImport({
            tenantId,
            initiatedByUserId: editorId,
            locationId,
            identifiers: [`${EKATTE}.10.1`, `${EKATTE}.99.99`],
        });

        expect(result.imported).toBe(1);
        expect(result.notFound).toEqual([`${EKATTE}.99.99`]);
        expect(result.ekatteCached).toContain(EKATTE);
        expect(result.ekatteFetched).toHaveLength(0);

        const ctx = ctxFor(tenantId, editorId);
        const parcels = await listLocationParcels(ctx, locationId);
        expect(parcels.parcels).toHaveLength(1);
        const p = parcels.parcels[0];
        expect(p.cadastralId).toBe(`${EKATTE}.10.1`);
        expect(p.ekatte).toBe(EKATTE);

        // PRIVACY: the owner column must NOT be persisted.
        const props = (p.properties ?? {}) as Record<string, unknown>;
        expect(props).not.toHaveProperty('SOBSTVENIK');
        expect(props.CADNUM).toBe(`${EKATTE}.10.1`);

        // Geometry reprojected to valid WGS84 inside Bulgaria.
        expect(p.geometry?.type).toBe('MultiPolygon');
        const coords = (p.geometry as GeoJSON.MultiPolygon).coordinates.flat(2) as [number, number][];
        for (const [lon, lat] of coords) {
            expect(lon).toBeGreaterThan(22);
            expect(lon).toBeLessThan(29);
            expect(lat).toBeGreaterThan(41);
            expect(lat).toBeLessThan(44.5);
        }
    });
});
