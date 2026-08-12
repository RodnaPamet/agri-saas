/**
 * Spatial-upload abuse hardening — DB-backed integration (real PostGIS).
 *
 * Proves the off-thread parcel-import job (`runLocationSpatialImport`):
 *   1. Happy path — a staged GeoJSON parses + persists its parcels off
 *      the request thread; the Location is stamped with the file/format/
 *      bounds.
 *   2. Topology fail-closed — a self-intersecting ("bowtie") polygon is
 *      rejected by the real `ST_IsValid` pass BEFORE any parcel is
 *      written; the Location is left untouched.
 *   3. Authorization — a READER (no write) and a non-member are both
 *      rejected; the job re-derives permission from ACTIVE membership.
 *   4. Tenant isolation — importing into a sibling tenant's location is
 *      "not found", never a cross-tenant write.
 *
 * BullMQ is bypassed (the byte-cap + complexity caps are unit-tested in
 * tests/unit/spatial/limits.test.ts); we exercise the worker's inner
 * function directly so the suite runs without Redis. The executor-
 * registry wiring is locked by the infrastructure guards.
 */

// Force the local storage provider BEFORE any storage module imports
// (env.ts defaults STORAGE_PROVIDER to "s3"; CI sets no S3_BUCKET).
process.env.STORAGE_PROVIDER = 'local';

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { Readable } from 'node:stream';
import type { Polygon, FeatureCollection } from 'geojson';

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
import { getPermissionsForRole } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string, role: 'EDITOR' | 'READER' = 'EDITOR'): RequestContext {
    return {
        requestId: `spatial-import-test-${Date.now()}`,
        userId,
        tenantId,
        role,
        permissions: computePermissions(role),
        appPermissions: getPermissionsForRole(role),
    };
}

function square(name: string, size: number, ox = 0, oy = 0): GeoJSON.Feature {
    const poly: Polygon = {
        type: 'Polygon',
        coordinates: [[[ox, oy], [ox, oy + size], [ox + size, oy + size], [ox + size, oy], [ox, oy]]],
    };
    return { type: 'Feature', properties: { name }, geometry: poly };
}

function fc(...features: GeoJSON.Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

/** Stage a GeoJSON payload to storage + register its FileRecord (mirrors the HTTP layer). */
async function stageGeoJson(
    tenantId: string,
    userId: string,
    name: string,
    collection: FeatureCollection,
): Promise<{ pathKey: string; fileRecordId: string }> {
    const buffer = Buffer.from(JSON.stringify(collection), 'utf8');
    const storage = getStorageProvider();
    const pathKey = buildTenantObjectKey(tenantId, 'spatial', `${name}-${Date.now()}.geojson`);
    const writeResult = await storage.write(pathKey, Readable.from(buffer), { mimeType: 'application/geo+json' });

    const ctx = ctxFor(tenantId, userId);
    const fileRecord = await runInTenantContext(ctx, async (db) => {
        const fr = await FileRepository.createPending(db, ctx, {
            pathKey,
            originalName: `${name}.geojson`,
            mimeType: 'application/geo+json',
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

describeFn('spatial-import hardening — integration (PostGIS)', () => {
    let testPrisma: PrismaClient;
    let tenantA = '';
    let tenantB = '';
    let editorId = '';
    let readerId = '';
    let foreignId = '';
    let locationA = '';
    let locationB = '';
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);

        const suffix = `spimport-${Date.now()}`;
        const aSlug = `${suffix}-a`;
        const bSlug = `${suffix}-b`;
        slugs.push(aSlug, bSlug);
        const a = await createTenantWithDek({ name: 'A', slug: aSlug });
        const b = await createTenantWithDek({ name: 'B', slug: bSlug });
        tenantA = a.id;
        tenantB = b.id;

        const editorEmail = `${suffix}-editor@example.com`;
        const readerEmail = `${suffix}-reader@example.com`;
        const foreignEmail = `${suffix}-foreign@example.com`;
        emails.push(editorEmail, readerEmail, foreignEmail);

        const editor = await testPrisma.user.create({ data: { email: editorEmail, name: 'Editor' } });
        const reader = await testPrisma.user.create({ data: { email: readerEmail, name: 'Reader' } });
        const foreign = await testPrisma.user.create({ data: { email: foreignEmail, name: 'Foreign' } });
        editorId = editor.id;
        readerId = reader.id;
        foreignId = foreign.id;

        await testPrisma.tenantMembership.createMany({
            data: [
                { userId: editorId, tenantId: tenantA, role: 'EDITOR', status: 'ACTIVE' },
                { userId: readerId, tenantId: tenantA, role: 'READER', status: 'ACTIVE' },
                // foreignId — member of B only, NOT of A
                { userId: foreignId, tenantId: tenantB, role: 'ADMIN', status: 'ACTIVE' },
            ],
        });

        const locA = await testPrisma.location.create({ data: { tenantId: tenantA, name: 'Home Farm A' } });
        const locB = await testPrisma.location.create({ data: { tenantId: tenantB, name: 'Home Farm B' } });
        locationA = locA.id;
        locationB = locB.id;
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        try {
            await testPrisma.parcel.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            // Null the spatialFile FK before deleting FileRecords.
            await testPrisma.location.updateMany({
                where: { tenantId: { in: [tenantA, tenantB] } },
                data: { spatialFileId: null },
            });
            await testPrisma.location.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await testPrisma.fileRecord.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await testPrisma.tenantMembership.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
            await testPrisma.tenant.deleteMany({ where: { slug: { in: slugs } } });
            await testPrisma.user.deleteMany({ where: { email: { in: emails } } });
        } catch {
            /* best effort */
        }
        await testPrisma.$disconnect();
    });

    test('happy path: a staged GeoJSON imports its parcels off-thread', async () => {
        const staged = await stageGeoJson(
            tenantA,
            editorId,
            'valid',
            fc(square('North 40', 0.01, 0, 0), square('South 80', 0.01, 0.02, 0)),
        );

        const result = await runLocationSpatialImport({
            tenantId: tenantA,
            initiatedByUserId: editorId,
            locationId: locationA,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
            filename: 'valid.geojson',
            mimeType: 'application/geo+json',
        });

        expect(result.format).toBe('geojson');
        expect(result.parcelCount).toBe(2);

        const parcels = await testPrisma.parcel.findMany({
            where: { tenantId: tenantA, locationId: locationA, deletedAt: null },
            select: { name: true, areaHa: true, tenantId: true },
        });
        expect(parcels.map((p) => p.name).sort()).toEqual(['North 40', 'South 80']);
        for (const p of parcels) {
            expect(p.tenantId).toBe(tenantA);
            expect(Number(p.areaHa)).toBeGreaterThan(0);
        }

        // Location stamped with file + format + bounds.
        const loc = await testPrisma.location.findUnique({
            where: { id: locationA },
            select: { spatialFileId: true, spatialFormat: true, boundsJson: true },
        });
        expect(loc!.spatialFileId).toBe(staged.fileRecordId);
        expect(loc!.spatialFormat).toBe('geojson');
        expect(Array.isArray(loc!.boundsJson)).toBe(true);
    });

    test('topology fail-closed: a self-intersecting polygon is rejected and writes nothing', async () => {
        // A "bowtie" — the ring crosses itself (ST_IsValid → false).
        const bowtie: Polygon = {
            type: 'Polygon',
            coordinates: [[[0, 0], [0.01, 0.01], [0.01, 0], [0, 0.01], [0, 0]]],
        };
        const staged = await stageGeoJson(
            tenantA,
            editorId,
            'bowtie',
            fc({ type: 'Feature', properties: { name: 'Bowtie' }, geometry: bowtie }),
        );

        // Seed the location with a known-good parcel first, then prove the
        // failed import did NOT delete/replace it (addParcelsForLocation never ran).
        const before = await testPrisma.parcel.count({
            where: { tenantId: tenantA, locationId: locationA, deletedAt: null },
        });

        await expect(
            runLocationSpatialImport({
                tenantId: tenantA,
                initiatedByUserId: editorId,
                locationId: locationA,
                stagingPathKey: staged.pathKey,
                stagingFileRecordId: staged.fileRecordId,
                filename: 'bowtie.geojson',
                mimeType: 'application/geo+json',
            }),
        ).rejects.toThrow(/self-intersecting|invalid/i);

        const after = await testPrisma.parcel.count({
            where: { tenantId: tenantA, locationId: locationA, deletedAt: null },
        });
        expect(after).toBe(before); // untouched — fail closed before persist
    });

    test('authorization: a READER (no write) is rejected', async () => {
        const staged = await stageGeoJson(tenantA, readerId, 'reader', fc(square('X', 0.01)));
        await expect(
            runLocationSpatialImport({
                tenantId: tenantA,
                initiatedByUserId: readerId,
                locationId: locationA,
                stagingPathKey: staged.pathKey,
                stagingFileRecordId: staged.fileRecordId,
                filename: 'reader.geojson',
            }),
        ).rejects.toThrow(/lacks write permission/);
    });

    test('authorization: a non-member of the target tenant is rejected', async () => {
        const staged = await stageGeoJson(tenantA, editorId, 'foreign', fc(square('X', 0.01)));
        await expect(
            runLocationSpatialImport({
                tenantId: tenantA,
                initiatedByUserId: foreignId, // member of B only
                locationId: locationA,
                stagingPathKey: staged.pathKey,
                stagingFileRecordId: staged.fileRecordId,
                filename: 'foreign.geojson',
            }),
        ).rejects.toThrow(/not an active member/);
    });

    test('tenant isolation: importing into a sibling tenant\'s location is not found', async () => {
        // foreign user is ADMIN in tenant B → has write — but locationB
        // belongs to B and the payload tenant is B; flip it: editor (A)
        // cannot import into locationB.
        const staged = await stageGeoJson(tenantA, editorId, 'isolation', fc(square('X', 0.01)));
        await expect(
            runLocationSpatialImport({
                tenantId: tenantA,
                initiatedByUserId: editorId,
                locationId: locationB, // belongs to tenant B
                stagingPathKey: staged.pathKey,
                stagingFileRecordId: staged.fileRecordId,
                filename: 'isolation.geojson',
            }),
        ).rejects.toThrow(/not found/i);

        // locationB never got parcels.
        const leaked = await testPrisma.parcel.count({ where: { locationId: locationB } });
        expect(leaked).toBe(0);
    });
});
