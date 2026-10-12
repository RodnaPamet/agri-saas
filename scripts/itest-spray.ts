/**
 * Integration driver for Feature 1 (spray-prescription map) against a
 * LIVE PostGIS database. Not a unit test — it exercises the real
 * usecases end-to-end (RLS, geometry I/O, audit, notifications):
 *
 *   create Location → import GeoJSON → verify PostGIS parcels + areaHa
 *   → create spray job (assigned operator) → operator marks parcels
 *   DONE → job auto-resolves. Plus an authorization check (assignee may
 *   complete their own job; a stranger may not).
 *
 *   npx tsx scripts/itest-spray.ts   # exit 0 = all assertions passed
 *
 * Requires the demo seed (tenant + users) and import:units to have run.
 */
process.env.SKIP_ENV_VALIDATION = '1';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import type { RequestContext } from '@/app-layer/types';
import { getPermissionsForRole } from '@/lib/permissions';
import { createLocation, listLocationParcels } from '@/app-layer/usecases/location';
import { stageLocationSpatialImport } from '@/app-layer/usecases/spatial-import';
import { runLocationSpatialImport } from '@/app-layer/jobs/spatial-import';
import { closeQueue } from '@/app-layer/jobs/queue';
import {
    createFieldOperation,
    getFieldOperation,
    markOperationParcel,
    listLocationOperations,
} from '@/app-layer/usecases/field-operation';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const prisma = new PrismaClient({ adapter });

let passed = 0;
let failed = 0;
function check(ok: boolean, msg: string) {
    console.log(`${ok ? '✅' : '❌'} ${msg}`);
    if (ok) passed += 1;
    else failed += 1;
}
async function expectThrow(fn: () => Promise<unknown>, msg: string) {
    try {
        await fn();
        check(false, `${msg} (expected throw, none happened)`);
    } catch {
        check(true, msg);
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctxFor(user: { id: string; role: any }, tenant: { id: string; slug?: string | null }): RequestContext {
    const role = user.role;
    return {
        requestId: randomUUID(),
        userId: user.id,
        tenantId: tenant.id,
        tenantSlug: tenant.slug ?? undefined,
        role,
        permissions: {
            canRead: true,
            canWrite: role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR',
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: role === 'AUDITOR',
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

const SAMPLE_GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', properties: { name: 'North Field', crop: 'Wheat' }, geometry: { type: 'Polygon', coordinates: [[[-0.10, 51.50], [-0.09, 51.50], [-0.09, 51.51], [-0.10, 51.51], [-0.10, 51.50]]] } },
        { type: 'Feature', properties: { name: 'South Field' }, geometry: { type: 'Polygon', coordinates: [[[-0.10, 51.48], [-0.09, 51.48], [-0.09, 51.49], [-0.10, 51.49], [-0.10, 51.48]]] } },
    ],
});

async function main() {
    const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!tenant) throw new Error('No tenant — run the demo seed first.');
    const memberships = await prisma.tenantMembership.findMany({ where: { tenantId: tenant.id }, select: { userId: true, role: true } });
    const owner = memberships.find((m) => m.role === 'OWNER');
    const editor = memberships.find((m) => m.role === 'EDITOR') ?? owner;
    const reader = memberships.find((m) => m.role === 'READER') ?? editor;
    if (!owner || !editor || !reader) throw new Error('Missing memberships (owner/editor/reader).');

    const adminCtx = ctxFor({ id: owner.userId, role: 'OWNER' }, tenant);
    const operatorCtx = ctxFor({ id: reader.userId, role: 'READER' }, tenant); // operator = low-priv user

    // ── product catalog: ensure a Unit + Item exist ──
    const lPerHa = await prisma.unit.findUnique({ where: { key: 'l-per-ha' } });
    const litre = await prisma.unit.findUnique({ where: { key: 'l' } });
    check(!!lPerHa && !!litre, 'Unit catalog seeded (l-per-ha, l)');
    const product = await prisma.item.create({
        data: { tenantId: tenant.id, name: `ITest Herbicide ${Date.now()}`, category: 'PESTICIDE', defaultUnitId: litre!.id },
    });

    // 1 ── create Location
    const location = await createLocation(adminCtx, { name: `ITest Block ${Date.now()}`, description: 'integration' });
    check(!!location.id, `createLocation → ${location.id}`);

    // 2 ── import a GeoJSON spatial file — TWO calls since #40
    //
    // #40 split the import in half, which is why this script stopped loading:
    // `importLocationSpatialFile` no longer exists. Staging is the cheap
    // synchronous half (authorize, detect format, enforce the per-format byte
    // cap, verify the Location, store the bytes with a REAL scan verdict,
    // enqueue); `runLocationSpatialImport` is the half that parses and writes
    // PostGIS, deliberately off the request thread because parsing a
    // shapefile/KML/GeoJSON is attacker-influenced CPU.
    //
    // The executor is invoked INLINE rather than polled (owner ruling
    // 2026-10-12), so the harness needs no worker and settles deterministically
    // instead of waiting on one. It does NOT make the script Redis-free —
    // `enqueue` is a real BullMQ `add`, and step 6 below already needs Redis
    // through `markOperationParcel`. Since Redis is already a dependency, the
    // real staging call is kept rather than hand-rolled: reaching past it
    // (as the integration suites do, for their own reasons) would skip the
    // authorization, the size cap and the scan verdict, which is most of what
    // an integration driver is for.
    const staged = await stageLocationSpatialImport(adminCtx, location.id, {
        filename: 'fields.geojson',
        buffer: Buffer.from(SAMPLE_GEOJSON),
        mimeType: 'application/geo+json',
    });
    check(!!staged.jobId, `stage → job ${staged.jobId}, format=${staged.format}`);

    // The storage key lives on the FileRecord, not in the stage result. READ
    // rather than recomputed: `buildTenantObjectKey` puts a `crypto.randomUUID()`
    // in the key, so deriving it a second time yields a path staging never
    // wrote and the executor would fail on a missing object.
    const stagedFile = await prisma.fileRecord.findUnique({
        where: { id: staged.fileRecordId },
        select: { pathKey: true },
    });
    check(!!stagedFile?.pathKey, `stage → FileRecord stored (${staged.fileRecordId})`);

    const imp = await runLocationSpatialImport({
        tenantId: tenant.id,
        initiatedByUserId: owner.userId,
        locationId: location.id,
        stagingPathKey: stagedFile!.pathKey,
        stagingFileRecordId: staged.fileRecordId,
        filename: 'fields.geojson',
        mimeType: 'application/geo+json',
    });
    // `parcelCount` is `matched + created` — the shapes the FILE held. Asserted
    // rather than `>= 2` because the whole point of the fixture is that it
    // contains exactly two.
    check(imp.parcelCount === 2, `import → 2 parcels (got ${imp.parcelCount}), format=${imp.format}`);
    check(Array.isArray(imp.bounds) && imp.bounds.length === 4, `import → bounds computed (${JSON.stringify(imp.bounds)})`);
    // The same record, so staging and the executor are provably talking about
    // one upload. `!!imp.fileRecordId` would pass on any id at all.
    check(
        imp.fileRecordId === staged.fileRecordId,
        `import → same FileRecord as staged (${imp.fileRecordId})`,
    );

    // 3 ── verify parcels carry PostGIS geometry + areaHa
    const { parcels } = await listLocationParcels(adminCtx, location.id);
    const geomOk = parcels.length === 2 && parcels.every((p) => p.geometry && (p.geometry as { type: string }).type === 'MultiPolygon');
    const areaOk = parcels.every((p) => typeof p.areaHa === 'number' && (p.areaHa as number) > 0);
    check(geomOk, `parcels render as MultiPolygon GeoJSON (${parcels.length})`);
    check(areaOk, `parcels have positive areaHa (ST_Area): ${parcels.map((p) => p.areaHa).join(', ')} ha`);

    // 4 ── create the spray job over both parcels, assigned to the operator
    const job = await createFieldOperation(adminCtx, location.id, {
        operationType: 'SPRAY',
        assigneeUserId: reader.userId,
        parcelIds: parcels.map((p) => p.id),
        productItemId: product.id,
        doseValue: 2.5,
        doseUnitId: lPerHa!.id,
        targetNote: 'Spot spray thistles',
    });
    check(!!job.taskId && job.parcelCount === 2, `createFieldOperation → task ${job.taskKey} w/ 2 lines`);

    // job is a FIELD_OPERATION Task, assigned, linked to the location
    const taskRow = await prisma.task.findUnique({ where: { id: job.taskId }, select: { type: true, assigneeUserId: true, status: true } });
    check(taskRow?.type === 'FIELD_OPERATION' && taskRow?.assigneeUserId === reader.userId, `job is FIELD_OPERATION assigned to operator (status=${taskRow?.status})`);
    const link = await prisma.taskLink.findFirst({ where: { taskId: job.taskId, entityType: 'LOCATION', entityId: location.id } });
    check(!!link, 'Task→Location TaskLink (entityType LOCATION) created');

    // 5 ── operator view exposes lines + parcel geometry
    const view = await getFieldOperation(operatorCtx, job.taskId);
    check(view.lines.length === 2 && view.parcels.length === 2, `operator view: ${view.lines.length} lines + ${view.parcels.length} parcels`);
    const lineIds = view.lines.map((l) => l.id);

    // 6 ── authorization: a stranger (not assignee, but has write) CAN (write perm);
    //      the assignee (READER, no write) CAN; a no-write non-assignee CANNOT.
    const auditorCtx = ctxFor({ id: editor.userId, role: 'AUDITOR' }, tenant); // no write, not assignee
    await expectThrow(() => markOperationParcel(auditorCtx, job.taskId, lineIds[0], 'DONE'), 'non-assignee without write is forbidden');

    // 7 ── operator marks parcels DONE → auto-resolve on the last one
    const r1 = await markOperationParcel(operatorCtx, job.taskId, lineIds[0], 'DONE');
    check(r1.resolved === false, 'mark line 1 DONE → job NOT yet resolved');
    const r2 = await markOperationParcel(operatorCtx, job.taskId, lineIds[1], 'DONE');
    check(r2.resolved === true, 'mark line 2 DONE → job AUTO-RESOLVED');

    const resolved = await prisma.task.findUnique({ where: { id: job.taskId }, select: { status: true, completedAt: true } });
    check(resolved?.status === 'RESOLVED' && !!resolved?.completedAt, `Task → RESOLVED w/ completedAt (${resolved?.status})`);

    // 8 ── location operations list reflects the job
    const ops = await listLocationOperations(adminCtx, location.id);
    check(ops.length >= 1, `location operations list → ${ops.length}`);

    // 9 ── assignment notification fired for the operator (bonus; needs tenantSlug)
    const notif = await prisma.notification.findFirst({ where: { tenantId: tenant.id, userId: reader.userId, type: 'TASK_ASSIGNED' } });
    check(!!notif, `assignment notification created for operator${notif ? '' : ' (skipped — no tenantSlug?)'}`);

    console.log(`\n${failed === 0 ? '🎉 ALL PASS' : '💥 FAILURES'} — ${passed} passed, ${failed} failed`);
    return failed === 0 ? 0 : 1;
}

// `closeQueue()` before the exit, on BOTH paths. `process.exit` would drop a
// lingering BullMQ handle anyway, but relying on that is what made the CI seed
// hang for forty minutes once the exit was refactored away — so the handle is
// released explicitly rather than left to the exit to paper over.
const shutdown = async (code: number): Promise<never> => {
    await closeQueue().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(code);
};

main()
    .then((code) => shutdown(code))
    .catch((err) => {
        console.error('FATAL', err);
        return shutdown(1);
    });
