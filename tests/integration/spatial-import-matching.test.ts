/**
 * Spatial re-import reconciliation — DB-backed integration (real PostGIS).
 *
 * Proves the behaviour #1116 asked for, against real geometry arithmetic
 * rather than a stubbed IoU:
 *
 *   1. A re-import of the SAME shapes matches them and updates IN PLACE — the
 *      parcel ids are unchanged, so everything keyed on `parcelId` survives
 *      without a migration. This is the whole point of the design.
 *   2. History actually follows. A crop season written against a parcel is
 *      still attached to that same parcel after the re-import — asserted
 *      directly, because "the id is the same" and "the child survived" are two
 *      claims and only the second is what a farmer cares about.
 *   3. A re-exported shape — perturbed the way a different tool would — still
 *      matches. This is what 0.90 was calibrated for.
 *   4. A shape moved far enough is NOT matched: it is inserted, and the old
 *      parcel is KEPT AND FLAGGED rather than deleted.
 *   5. A file that omits a parcel leaves it in place with `absentFromImportAt`
 *      set, and a later file that includes it again CLEARS the flag.
 *   6. Two incoming shapes cannot both claim one existing parcel.
 *
 * (6) is the one worth stating plainly: without the one-to-one rule the second
 * shape would update the same row the first did, the first import's geometry
 * would be silently overwritten, and the file would report two parcels
 * imported while the location gained one. It fails as a SUCCESS, which is the
 * shape of defect this suite exists for.
 */
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
import { runInTenantContext } from '@/lib/db-context';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { runLocationSpatialImport } from '@/app-layer/jobs/spatial-import';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `spatial-match-test-${Date.now()}`,
        userId,
        tenantId,
        role: 'EDITOR',
        permissions: computePermissions('EDITOR'),
        appPermissions: getPermissionsForRole('EDITOR'),
    };
}

/** An axis-aligned square, in degrees. */
function square(name: string, size: number, ox = 0, oy = 0): GeoJSON.Feature {
    const poly: Polygon = {
        type: 'Polygon',
        coordinates: [[[ox, oy], [ox, oy + size], [ox + size, oy + size], [ox + size, oy], [ox, oy]]],
    };
    return { type: 'Feature', properties: { name }, geometry: poly };
}

/**
 * The same square with one corner nudged — a re-export, not a re-draw.
 *
 * `delta` is a fraction of the side, so the IoU degradation is scale-free and
 * the test does not depend on the absolute size chosen.
 */
function nudgedSquare(name: string, size: number, ox: number, oy: number, delta: number): GeoJSON.Feature {
    const d = size * delta;
    const poly: Polygon = {
        type: 'Polygon',
        coordinates: [[
            [ox, oy],
            [ox, oy + size],
            [ox + size - d, oy + size - d],
            [ox + size, oy],
            [ox, oy],
        ]],
    };
    return { type: 'Feature', properties: { name }, geometry: poly };
}

function fc(...features: GeoJSON.Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

jest.setTimeout(60_000);

describeFn('spatial re-import reconciliation — integration (PostGIS)', () => {
    let testPrisma: PrismaClient;
    let tenantId = '';
    let editorId = '';
    let locationId = '';
    const slugs: string[] = [];
    const emails: string[] = [];

    async function stage(name: string, collection: FeatureCollection) {
        const buffer = Buffer.from(JSON.stringify(collection), 'utf8');
        const storage = getStorageProvider();
        const pathKey = buildTenantObjectKey(tenantId, 'spatial', `${name}-${Date.now()}-${Math.random()}.geojson`);
        const w = await storage.write(pathKey, Readable.from(buffer), { mimeType: 'application/geo+json' });
        const ctx = ctxFor(tenantId, editorId);
        const fr = await runInTenantContext(ctx, async (db) => {
            const rec = await FileRepository.createPending(db, ctx, {
                pathKey,
                originalName: `${name}.geojson`,
                mimeType: 'application/geo+json',
                sizeBytes: w.sizeBytes,
                sha256: w.sha256,
                domain: 'spatial',
            });
            await FileRepository.markStored(db, ctx, rec.id, 'SKIPPED');
            return rec;
        });
        return { pathKey, fileRecordId: fr.id };
    }

    async function importFile(name: string, collection: FeatureCollection) {
        const staged = await stage(name, collection);
        return runLocationSpatialImport({
            tenantId,
            initiatedByUserId: editorId,
            locationId,
            stagingPathKey: staged.pathKey,
            stagingFileRecordId: staged.fileRecordId,
            filename: `${name}.geojson`,
            mimeType: 'application/geo+json',
        });
    }

    const liveParcels = () =>
        testPrisma.parcel.findMany({
            where: { tenantId, locationId, deletedAt: null },
            select: { id: true, name: true, absentFromImportAt: true, areaHa: true },
            orderBy: { name: 'asc' },
        });

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);

        const suffix = `spmatch-${Date.now()}`;
        const slug = `${suffix}-t`;
        slugs.push(slug);
        const t = await createTenantWithDek({ name: 'Match', slug });
        tenantId = t.id;

        const email = `${suffix}@example.com`;
        emails.push(email);
        const u = await testPrisma.user.create({ data: { email, name: 'Editor' } });
        editorId = u.id;
        await testPrisma.tenantMembership.create({
            data: { userId: editorId, tenantId, role: 'EDITOR', status: 'ACTIVE' },
        });
        const loc = await testPrisma.location.create({ data: { tenantId, name: 'Match Farm' } });
        locationId = loc.id;
    });

    afterAll(async () => {
        if (!DB_AVAILABLE) return;
        try {
            await testPrisma.parcelCropSeason.deleteMany({ where: { tenantId } });
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

    test('re-importing the SAME file matches every parcel and creates nothing', async () => {
        const file = fc(square('North', 0.01, 0, 0), square('South', 0.01, 0, 0.02));

        const first = await importFile('first', file);
        expect(first.created).toBe(2);
        expect(first.matched).toBe(0);
        expect(first.flagged).toBe(0);

        const idsAfterFirst = (await liveParcels()).map((p) => p.id).sort();
        expect(idsAfterFirst).toHaveLength(2);

        const second = await importFile('second', file);
        expect(second.matched).toBe(2);
        expect(second.created).toBe(0);
        expect(second.flagged).toBe(0);

        // The ids are the SAME rows. Before this change a re-import produced
        // four parcels, two of them carrying no history.
        const idsAfterSecond = (await liveParcels()).map((p) => p.id).sort();
        expect(idsAfterSecond).toEqual(idsAfterFirst);
        expect(await testPrisma.parcel.count({ where: { tenantId, locationId, deletedAt: null } })).toBe(2);
    });

    test('a crop season is INHERITED by the updated row, not merely left undeleted', async () => {
        // The claim that matters, and it needs care to state. An earlier
        // version of this test asserted only that the season still pointed at
        // the same parcel id — which stays TRUE even when matching is disabled
        // entirely, because the original row survives (flagged) and the season
        // keeps pointing at it. Mutation-proving caught that: turning the match
        // path off reddened four tests and not this one.
        //
        // So it asserts the thing that can only be true if the row was UPDATED
        // IN PLACE: the parcel carrying the season now holds the NEW geometry.
        // If the import had inserted a duplicate instead, the season's parcel
        // would still carry the OLD area and a different row would hold the
        // new shape.
        const parcels = await liveParcels();
        const target = parcels.find((p) => p.name === 'North')!;
        expect(target).toBeDefined();
        const areaBefore = target.areaHa === null ? null : Number(target.areaHa);
        expect(areaBefore).not.toBeNull();

        const season = await testPrisma.parcelCropSeason.create({
            data: { tenantId, parcelId: target.id, cropType: 'Wheat', year: 2026 },
            select: { id: true },
        });

        // Re-import with 'North' nudged by 5% of its side — enough to move the
        // area measurably, and comfortably inside the match threshold. (0.2 was
        // the first attempt and is NOT a re-export: pulling the corner vertex
        // that far removes a fifth of the area, IoU 0.80, and the threshold
        // correctly refused to call it the same field. Worth keeping in the
        // record — it is the clearest demonstration that 0.90 discriminates.)
        const res = await importFile(
            'inherit',
            fc(nudgedSquare('North', 0.01, 0, 0, 0.05), square('South', 0.01, 0, 0.02)),
        );
        // Both shapes must have MATCHED — if either was inserted instead, the
        // assertions below would be testing the wrong row.
        expect({ matched: res.matched, created: res.created }).toEqual({ matched: 2, created: 0 });

        const after = await testPrisma.parcelCropSeason.findUnique({
            where: { id: season.id },
            select: { parcelId: true },
        });
        expect(after?.parcelId).toBe(target.id);

        const carrier = (await liveParcels()).find((p) => p.id === target.id);
        expect(carrier).toBeDefined();
        const areaAfter = carrier!.areaHa === null ? null : Number(carrier!.areaHa);
        expect(areaAfter).not.toBeNull();
        // The row the season hangs off RECEIVED the new geometry.
        expect(areaAfter).toBeLessThan(areaBefore!);
    });

    test('a RE-EXPORTED shape (one corner nudged) still matches — what 0.90 is for', async () => {
        const before = await liveParcels();
        const beforeIds = before.map((p) => p.id).sort();

        // ~5% of the side on one corner: a tool difference, not a re-draw.
        const result = await importFile(
            'reexport',
            fc(nudgedSquare('North', 0.01, 0, 0, 0.05), square('South', 0.01, 0, 0.02)),
        );

        expect(result.matched).toBe(2);
        expect(result.created).toBe(0);
        expect((await liveParcels()).map((p) => p.id).sort()).toEqual(beforeIds);
    });

    test('a shape moved far away is NOT matched: it is inserted and the old one is FLAGGED', async () => {
        const before = await liveParcels();
        expect(before).toHaveLength(2);

        // Only 'South' is in this file, and 'North' has moved somewhere with
        // no overlap at all — so it is a new parcel, not a re-draw.
        const result = await importFile(
            'moved',
            fc(square('Elsewhere', 0.01, 5, 5), square('South', 0.01, 0, 0.02)),
        );

        expect(result.matched).toBe(1); // South
        expect(result.created).toBe(1); // Elsewhere
        expect(result.flagged).toBe(1); // North, kept

        const after = await liveParcels();
        expect(after).toHaveLength(3); // nothing was deleted

        const north = after.find((p) => p.name === 'North');
        expect(north).toBeDefined();
        expect(north?.absentFromImportAt).not.toBeNull();

        const south = after.find((p) => p.name === 'South');
        expect(south?.absentFromImportAt).toBeNull();
    });

    test('a shape that OVERLAPS but is re-drawn is NOT matched — this is the threshold itself', async () => {
        // The case the "moved far away" test does NOT cover. A shape 5 degrees
        // away never reaches the threshold at all: `ST_Intersects` rejects it
        // as a candidate first, so that test passes at ANY threshold including
        // zero. Mutation-proving found exactly that.
        //
        // This one overlaps heavily — offset by 30% of its side, so
        // IoU ≈ 0.7/1.3 ≈ 0.54 — which is unambiguously the SAME GROUND but a
        // different field boundary. Above 0.54 it must be inserted as new;
        // below it, it would wrongly claim the existing parcel and inherit its
        // history.
        const seeded = await importFile('overlap-seed', fc(square('Solo', 0.01, 1, 1)));
        expect(seeded.created).toBe(1);
        const soloBefore = (await liveParcels()).find((p) => p.name === 'Solo');
        expect(soloBefore).toBeDefined();

        const redrawn = await importFile('overlap-redraw', fc(square('Solo redrawn', 0.01, 1.003, 1)));

        // A NEW parcel, not a match: 0.54 is below the 0.90 threshold.
        expect(redrawn.created).toBe(1);

        const after = await liveParcels();
        const stillThere = after.find((p) => p.id === soloBefore!.id);
        expect(stillThere).toBeDefined();
        // And the original was kept and flagged rather than silently replaced.
        expect(stillThere?.absentFromImportAt).not.toBeNull();
    });

    test('re-including a flagged parcel CLEARS the flag', async () => {
        const flaggedBefore = await testPrisma.parcel.count({
            where: { tenantId, locationId, deletedAt: null, absentFromImportAt: { not: null } },
        });
        expect(flaggedBefore).toBeGreaterThan(0);

        await importFile(
            'reinclude',
            fc(square('North', 0.01, 0, 0), square('South', 0.01, 0, 0.02), square('Elsewhere', 0.01, 5, 5)),
        );

        const north = (await liveParcels()).find((p) => p.name === 'North');
        expect(north?.absentFromImportAt).toBeNull();
    });

    test('two incoming shapes cannot both claim ONE existing parcel', async () => {
        // Both squares overlap the existing 'North' heavily. Without the
        // one-to-one rule both would update that row, the second overwriting
        // the first, and the import would report two parcels while the
        // location gained none — a failure that presents as success.
        const countBefore = await testPrisma.parcel.count({
            where: { tenantId, locationId, deletedAt: null },
        });

        const result = await importFile(
            'double-claim',
            fc(
                square('North', 0.01, 0, 0),
                nudgedSquare('North copy', 0.01, 0, 0, 0.02),
                square('South', 0.01, 0, 0.02),
                square('Elsewhere', 0.01, 5, 5),
            ),
        );

        // Exactly one of the two overlapping shapes matched 'North'; the other
        // had to become a new parcel.
        expect(result.matched + result.created).toBe(4);
        expect(result.created).toBeGreaterThanOrEqual(1);

        const countAfter = await testPrisma.parcel.count({
            where: { tenantId, locationId, deletedAt: null },
        });
        // The location GREW by the shapes that could not claim a row. It did
        // not stay the same, which is what a silent double-update looks like.
        expect(countAfter).toBe(countBefore + result.created);
    });
});
