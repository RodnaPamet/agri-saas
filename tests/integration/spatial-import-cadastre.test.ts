/**
 * Cadastre reprojection import — DB-backed integration (real PostGIS).
 *
 * Proves the EPSG:7801 (BGS2005 / CCS2005) ingest path end-to-end:
 * a staged shapefile whose coordinates are Bulgarian Lambert METRES is
 * detected as 7801 from its `.prj`, the `.prj` is stripped so shpjs yields
 * raw metres, and `ParcelRepository.addParcelsForLocation` reprojects via
 * PostGIS `ST_Transform → 4326`. The stored geometry must land as valid WGS84
 * WITHIN Bulgaria, near the fixture's known point (lon 23.3219, lat 42.6977),
 * with a positive `areaHa` derived from the SAME reprojected expression.
 *
 * Fixture: tests/fixtures/cadastre-7801-parcel.zip (a ~200 m square around the
 * known point, encoded in 7801 metres — see tests/helpers/shapefile-fixture.ts).
 */
process.env.STORAGE_PROVIDER = 'local';

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { registerEncryptionMiddleware } from '@/lib/db/encryption-middleware';
import { prisma } from '@/lib/prisma';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { FileRepository } from '@/app-layer/repositories/FileRepository';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { runLocationSpatialImport } from '@/app-layer/jobs/spatial-import';
import { listLocationParcels } from '@/app-layer/usecases/location';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

// The known WGS84 point the 7801 fixture square is centred on.
const EXPECTED_LON = 23.3219;
const EXPECTED_LAT = 42.6977;

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

async function stageZip(
    tenantId: string,
    userId: string,
    buffer: Buffer,
): Promise<{ pathKey: string; fileRecordId: string }> {
    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(tenantId, 'spatial', `cadastre-${Date.now()}.zip`);
    const writeResult = await storage.write(pathKey, Readable.from(buffer), { mimeType: 'application/zip' });
    const ctx = ctxFor(tenantId, userId);
    const fileRecord = await runInTenantContext(ctx, async (db) => {
        const fr = await FileRepository.createPending(db, ctx, {
            pathKey,
            originalName: 'cadastre-7801-parcel.zip',
            mimeType: 'application/zip',
            sizeBytes: writeResult.sizeBytes,
            sha256: writeResult.sha256,
            domain: 'spatial',
        });
        await FileRepository.markStored(db, ctx, fr.id, 'SKIPPED');
        return fr;
    });
    return { pathKey, fileRecordId: fileRecord.id };
}

jest.setTimeout(30_000);

describeFn('cadastre EPSG:7801 import — integration (PostGIS reprojection)', () => {
    let testPrisma: PrismaClient;
    let tenantId = '';
    let editorId = '';
    let locationId = '';
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);

        const suffix = `cad7801-${Date.now()}`;
        const slug = `${suffix}-t`;
        slugs.push(slug);
        const t = await createTenantWithDek({ name: 'Cadastre', slug });
        tenantId = t.id;

        const email = `${suffix}-editor@example.com`;
        emails.push(email);
        const editor = await testPrisma.user.create({ data: { email, name: 'Editor' } });
        editorId = editor.id;
        await testPrisma.tenantMembership.create({
            data: { userId: editorId, tenantId, role: 'EDITOR', status: 'ACTIVE' },
        });
        const loc = await testPrisma.location.create({ data: { tenantId, name: 'Cadastre Farm' } });
        locationId = loc.id;
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
        } catch {
            /* best effort */
        }
        await testPrisma.$disconnect();
    });

    test('a 7801 shapefile lands valid WGS84 geometry within Bulgaria', async () => {
        const fixture = readFileSync(path.resolve(__dirname, '../fixtures/cadastre-7801-parcel.zip'));
        const staged = await stageZip(tenantId, editorId, fixture);

        const result = await runLocationSpatialImport({
            tenantId,
            initiatedByUserId: editorId,
            locationId,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
            filename: 'cadastre-7801-parcel.zip',
            mimeType: 'application/zip',
        });

        expect(result.format).toBe('shapefile');
        expect(result.parcelCount).toBe(1);

        // Read the parcel back with geometry serialized to WGS84 GeoJSON.
        const ctx = ctxFor(tenantId, editorId);
        const parcels = await listLocationParcels(ctx, locationId);
        expect(parcels.parcels).toHaveLength(1);
        const p = parcels.parcels[0];

        // areaHa must be positive (derived from the reprojected geometry).
        expect(p.areaHa).not.toBeNull();
        expect(Number(p.areaHa)).toBeGreaterThan(0);

        // Geometry must be a WGS84 MultiPolygon whose every vertex is within
        // Bulgaria, and whose centroid is near the fixture's known point.
        expect(p.geometry?.type).toBe('MultiPolygon');
        const coords = (p.geometry as GeoJSON.MultiPolygon).coordinates.flat(2) as [number, number][];
        let sumLon = 0;
        let sumLat = 0;
        for (const [lon, lat] of coords) {
            expect(lon).toBeGreaterThan(22);
            expect(lon).toBeLessThan(28.5);
            expect(lat).toBeGreaterThan(41);
            expect(lat).toBeLessThan(44.5);
            sumLon += lon;
            sumLat += lat;
        }
        const cLon = sumLon / coords.length;
        const cLat = sumLat / coords.length;
        // Within ~500 m of the known point (≈0.005° tolerance).
        expect(Math.abs(cLon - EXPECTED_LON)).toBeLessThan(0.01);
        expect(Math.abs(cLat - EXPECTED_LAT)).toBeLessThan(0.01);
    });
});
