/**
 * Part A (PR2) — prj-less projected-CRS import + PostGIS source-SRID PROBE.
 *
 * Phase 1 handled a shapefile whose `.prj` resolves the CRS. Part A handles the
 * ABSENT-`.prj` case: the parser flags `sourceCrs: 'projected-candidate'` and
 * the write path PROBES 7801 (КС2005) vs 32635 (UTM 35N) by which candidate's
 * transformed bounds land inside Bulgaria.
 *
 * The two candidate CRSs overlap in metre magnitude over central Bulgaria, so a
 * clean disambiguation requires the WRONG interpretation to fall OUTSIDE the
 * Bulgaria envelope. These fixtures use EDGE coordinates for that:
 *   • EASTERN point (near Silistra) in 7801 metres → as 32635 it lands at
 *     lon > 29 (outside) ⇒ 7801 is the unique match.
 *   • WESTERN point (near Blagoevgrad) in 32635 metres → as 7801 it lands at
 *     lon < 22 (outside) ⇒ 32635 is the unique match.
 * Fixtures are built by transforming a known WGS84 ring to the source CRS with
 * PostGIS (no proj4 in JS), then STRIPPING the `.prj` so the parser must probe.
 *
 * Also asserts EPSG:7801 is present in `spatial_ref_sys` (the migration inserts
 * it idempotently for self-hosted PostGIS builds that omit the national grids).
 */
process.env.STORAGE_PROVIDER = 'local';

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

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
import { buildPolygonShapefileZip } from '../helpers/shapefile-fixture';
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `cadastre-probe-test-${Date.now()}`,
        userId,
        tenantId,
        role: 'EDITOR',
        permissions: computePermissions('EDITOR'),
        appPermissions: getPermissionsForRole('EDITOR'),
    };
}

jest.setTimeout(40_000);

describeFn('Part A — prj-less projected-CRS import via PostGIS probe', () => {
    let testPrisma: PrismaClient;
    let tenantId = '';
    let editorId = '';
    const slugs: string[] = [];
    const emails: string[] = [];

    /** Transform a WGS84 ring to `srid` metres via PostGIS (fixture builder). */
    async function toSridRing(
        ring: Array<[number, number]>,
        srid: number,
    ): Promise<Array<[number, number]>> {
        const out: Array<[number, number]> = [];
        for (const [lon, lat] of ring) {
            const rows = await testPrisma.$queryRawUnsafe<Array<{ x: number; y: number }>>(
                `SELECT ST_X(g) AS x, ST_Y(g) AS y FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326), ${srid}) AS g) s`,
            );
            out.push([Number(rows[0].x), Number(rows[0].y)]);
        }
        return out;
    }

    async function stageZip(buffer: Buffer): Promise<{ pathKey: string; fileRecordId: string }> {
        const storage = getStorageProvider();
        const pathKey = buildTenantObjectKey(tenantId, 'spatial', `probe-${Date.now()}-${Math.random()}.zip`);
        const writeResult = await storage.write(pathKey, Readable.from(buffer), { mimeType: 'application/zip' });
        const ctx = ctxFor(tenantId, editorId);
        const fileRecord = await runInTenantContext(ctx, async (db) => {
            const fr = await FileRepository.createPending(db, ctx, {
                pathKey,
                originalName: 'probe.zip',
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

    async function importAndReadCentroid(buffer: Buffer): Promise<{ lon: number; lat: number; parcelCount: number }> {
        const staged = await stageZip(buffer);
        const loc = await testPrisma.location.create({ data: { tenantId, name: `L-${Math.random()}` } });
        const result = await runLocationSpatialImport({
            tenantId,
            initiatedByUserId: editorId,
            locationId: loc.id,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
            filename: 'probe.zip',
            mimeType: 'application/zip',
        });
        const ctx = ctxFor(tenantId, editorId);
        const parcels = await listLocationParcels(ctx, loc.id);
        const coords = (parcels.parcels[0].geometry as GeoJSON.MultiPolygon).coordinates.flat(2) as [number, number][];
        const lon = coords.reduce((s, c) => s + c[0], 0) / coords.length;
        const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        return { lon, lat, parcelCount: result.parcelCount };
    }

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);
        const suffix = `cadprobe-${Date.now()}`;
        const slug = `${suffix}-t`;
        slugs.push(slug);
        const t = await createTenantWithDek({ name: 'Probe', slug });
        tenantId = t.id;
        const email = `${suffix}-editor@example.com`;
        emails.push(email);
        const editor = await testPrisma.user.create({ data: { email, name: 'Editor' } });
        editorId = editor.id;
        await testPrisma.tenantMembership.create({
            data: { userId: editorId, tenantId, role: 'EDITOR', status: 'ACTIVE' },
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
        } catch {
            /* best effort */
        }
        await testPrisma.$disconnect();
    });

    test('EPSG:7801 is present in spatial_ref_sys', async () => {
        const rows = await testPrisma.$queryRawUnsafe<Array<{ srid: number }>>(
            'SELECT srid FROM spatial_ref_sys WHERE srid = 7801',
        );
        expect(rows).toHaveLength(1);
    });

    test('a prj-less EASTERN 7801 shapefile probes to 7801 and lands back at its point', async () => {
        // Eastern Bulgaria (near Silistra) — as 32635 this lands lon>29 (outside).
        const wgs: Array<[number, number]> = [
            [28.300, 43.500], [28.3025, 43.500], [28.3025, 43.5018], [28.300, 43.5018], [28.300, 43.500],
        ];
        const ring7801 = await toSridRing(wgs, 7801);
        const zip = await buildPolygonShapefileZip({ ring: ring7801 }); // NO .prj
        const { lon, lat, parcelCount } = await importAndReadCentroid(zip);
        expect(parcelCount).toBe(1);
        expect(Math.abs(lon - 28.3013)).toBeLessThan(0.01);
        expect(Math.abs(lat - 43.5009)).toBeLessThan(0.01);
    });

    test('a prj-less WESTERN 32635 shapefile probes to 32635 and lands back at its point', async () => {
        // Western Bulgaria (near Blagoevgrad) — as 7801 this lands lon<22 (outside).
        const wgs: Array<[number, number]> = [
            [23.000, 42.000], [23.0025, 42.000], [23.0025, 42.0018], [23.000, 42.0018], [23.000, 42.000],
        ];
        const ring32635 = await toSridRing(wgs, 32635);
        const zip = await buildPolygonShapefileZip({ ring: ring32635 }); // NO .prj
        const { lon, lat, parcelCount } = await importAndReadCentroid(zip);
        expect(parcelCount).toBe(1);
        expect(Math.abs(lon - 23.0013)).toBeLessThan(0.01);
        expect(Math.abs(lat - 42.0009)).toBeLessThan(0.01);
    });
});
