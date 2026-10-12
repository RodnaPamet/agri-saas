/**
 * The handoff between the two halves of a spatial import (#1659).
 *
 * ## What had no test at all
 *
 * #40 split the import: `stageLocationSpatialImport` is the synchronous half
 * (authorize, detect format, enforce the per-format byte cap, verify the
 * Location, write the bytes with a real scan verdict, enqueue) and
 * `runLocationSpatialImport` is the half that parses and writes PostGIS off the
 * request thread, because parsing a shapefile/KML/GeoJSON is
 * attacker-influenced CPU.
 *
 * The executor half is covered by four integration suites. The STAGING half was
 * covered by `expect(typeof spatialImport.stageLocationSpatialImport).toBe(
 * 'function')` and nothing else, and the HANDOFF between them by nothing — the
 * four suites all stage by hand (`FileRepository.createPending` +
 * `markStored`) and build the executor payload themselves, so none of them
 * would notice if the real staging produced a payload the executor could not
 * use.
 *
 * That gap is what let `scripts/itest-spray.ts` sit broken from #40 until
 * #1485 typechecked it: the script was the only caller that went through both,
 * and it could not load.
 *
 * ## Two claims, because two callers read the key differently
 *
 * 1. **The enqueued payload drives the executor.** The worker receives exactly
 *    what `enqueue` was called with, so running the executor on the CAPTURED
 *    payload is the production path with the queue hop removed — not an
 *    approximation of it.
 * 2. **`FileRecord.pathKey` is the same key.** `itest-spray.ts` has no access
 *    to the enqueued payload, so it reads the key off the FileRecord. That
 *    is only sound if the two agree, and `buildTenantObjectKey` embeds a
 *    `crypto.randomUUID()` — so a caller that recomputed the key instead would
 *    get a path staging never wrote, and the executor would fail on a missing
 *    object.
 *
 * ## No Redis
 *
 * `enqueue` is mocked, which is also what makes claim 1 observable: the mock is
 * how the payload is captured. Everything else in staging runs for real,
 * including the storage write and the scan verdict.
 */
import dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import type { FeatureCollection } from 'geojson';

const enqueue = jest.fn(async () => ({ id: 'job-stage-to-executor' }));
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: (...args: unknown[]) => enqueue(...(args as [])),
}));

import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { registerEncryptionMiddleware } from '@/lib/db/encryption-middleware';
import { prisma } from '@/lib/prisma';
import { computePermissions } from '@/lib/tenant-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import type { SpatialImportJobPayload } from '@/app-layer/jobs/types';
import { stageLocationSpatialImport } from '@/app-layer/usecases/spatial-import';
import { runLocationSpatialImport } from '@/app-layer/jobs/spatial-import';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

/** Two non-overlapping squares, so `parcelCount` has an expected value. */
const TWO_FIELDS: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: { name: 'North Field' },
            geometry: {
                type: 'Polygon',
                coordinates: [[[0, 0], [0, 0.01], [0.01, 0.01], [0.01, 0], [0, 0]]],
            },
        },
        {
            type: 'Feature',
            properties: { name: 'South Field' },
            geometry: {
                type: 'Polygon',
                coordinates: [[[0, 0.02], [0, 0.03], [0.01, 0.03], [0.01, 0.02], [0, 0.02]]],
            },
        },
    ],
};

describeFn('spatial import — staging hands off to the executor (#1659)', () => {
    let testPrisma: PrismaClient;
    let tenantId = '';
    let editorId = '';
    let locationId = '';
    const slugs: string[] = [];
    const emails: string[] = [];

    const ctx = (): RequestContext => ({
        requestId: `stage-to-exec-${Date.now()}`,
        userId: editorId,
        tenantId,
        role: 'EDITOR',
        permissions: computePermissions('EDITOR'),
        appPermissions: getPermissionsForRole('EDITOR'),
    });

    beforeAll(async () => {
        if (!DB_AVAILABLE) return;
        testPrisma = prismaTestClient();
        await testPrisma.$connect();
        registerEncryptionMiddleware(prisma);

        const suffix = `spstage-${Date.now()}`;
        const slug = `${suffix}-t`;
        slugs.push(slug);
        const t = await createTenantWithDek({ name: 'Stage', slug });
        tenantId = t.id;

        const email = `${suffix}@example.com`;
        emails.push(email);
        const u = await testPrisma.user.create({ data: { email, name: 'Editor' } });
        editorId = u.id;
        await testPrisma.tenantMembership.create({
            data: { userId: editorId, tenantId, role: 'EDITOR', status: 'ACTIVE' },
        });
        const loc = await testPrisma.location.create({ data: { tenantId, name: 'Stage Farm' } });
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

    test('the payload staging enqueues imports both parcels, and the FileRecord carries the same key', async () => {
        enqueue.mockClear();

        const staged = await stageLocationSpatialImport(ctx(), locationId, {
            filename: 'fields.geojson',
            buffer: Buffer.from(JSON.stringify(TWO_FIELDS), 'utf8'),
            mimeType: 'application/geo+json',
        });

        expect(staged.format).toBe('geojson');
        expect(staged.fileRecordId).toBeTruthy();

        // ── claim 1: the enqueued payload is what the worker would get ──
        expect(enqueue).toHaveBeenCalledTimes(1);
        const [jobName, payload] = enqueue.mock.calls[0] as unknown as [
            string,
            SpatialImportJobPayload,
        ];
        expect(jobName).toBe('spatial-import');

        const result = await runLocationSpatialImport(payload);
        expect(result.parcelCount).toBe(2);
        expect(result.created).toBe(2);
        expect(result.bounds).toHaveLength(4);
        expect(result.fileRecordId).toBe(staged.fileRecordId);

        // The parcels are really there — `parcelCount` is the executor's own
        // report, so a return value alone would not distinguish "wrote two
        // rows" from "counted two features".
        const parcels = await testPrisma.parcel.findMany({
            where: { tenantId, locationId, deletedAt: null },
            select: { name: true },
            orderBy: { name: 'asc' },
        });
        expect(parcels.map((p) => p.name)).toEqual(['North Field', 'South Field']);

        // ── claim 2: the key a caller can READ matches the enqueued one ──
        const record = await testPrisma.fileRecord.findUnique({
            where: { id: staged.fileRecordId },
            select: { pathKey: true },
        });
        expect(record?.pathKey).toBe(payload.stagingPathKey);
        // And it is not a key anybody could have guessed — the random segment
        // is what makes reading it rather than recomputing it necessary.
        expect(record!.pathKey).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    test('staging refuses an unsupported file type before writing anything', async () => {
        // The control for claim 1: without it, a `stageLocationSpatialImport`
        // that enqueued unconditionally and validated nothing would satisfy
        // every assertion above. This is also the cheapest of the four things
        // staging does that reaching past it would skip.
        enqueue.mockClear();
        const before = await testPrisma.fileRecord.count({ where: { tenantId } });

        await expect(
            stageLocationSpatialImport(ctx(), locationId, {
                filename: 'fields.txt',
                buffer: Buffer.from('not spatial', 'utf8'),
                mimeType: 'text/plain',
            }),
        ).rejects.toMatchObject({ status: 400 });

        expect(enqueue).not.toHaveBeenCalled();
        expect(await testPrisma.fileRecord.count({ where: { tenantId } })).toBe(before);
    });
});
